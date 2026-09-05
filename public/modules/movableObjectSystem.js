import * as THREE from "three";
import * as CANNON from "cannon-es";
import {
    BALL_RADIUS,
    BLOOM_LAYER,
    TRIGGER_EXPAND,
    MOVABLE_SECTION_PATTERN,
    MOVABLE_OBJECTS_GROUP_PATTERN,
    MOVABLE_RESET_TRIGGER_PATTERN,
    MOVABLE_MASS,
    MOVABLE_LINEAR_DAMPING,
    MOVABLE_ANGULAR_DAMPING,
    MOVABLE_FRICTION,
    MOVABLE_RESTITUTION,
    MOVABLE_BALL_RESTITUTION,
    MOVABLE_MAX_LINEAR_SPEED,
    MOVABLE_MAX_ANGULAR_SPEED,
    MOVABLE_RADIUS_SHRINK,
    MOVABLE_RESET_POPUP_HEIGHT,
    MOVABLE_RESET_GLOW_COLOR,
} from "./config.js";

// Owns every "MovableObjectSection" authored in the level GLB: a group of
// gravity-affected, ball-pushable props (its "MovableObjects" children) plus
// a sibling "MovableObjectResetTrigger" cylinder that, once rolled onto,
// asks — via MovableObjectUI's world-anchored popup — whether to snap that
// section's props back to their authored positions. Any number of sections
// can be authored (currently two); each only ever resets its own objects,
// same isolation GameModeManager's Start/EndTrigger pair doesn't need but
// HotspotSystem's per-node registration already models well.
export class MovableObjectSystem {
    constructor({ scene, world, floorMaterial, wallMaterial, ballMaterial, player, ui }) {
        this.scene = scene;
        this.world = world;
        this.player = player;
        this.ui = ui;

        this.sections = []; // { objects: [{mesh,body,initialPosition,initialQuaternion}], trigger: {...}|null, inside }
        this.activeSection = null; // the one section currently showing its confirmation, or null

        // A dedicated physics material for every movable prop, tuned softer
        // (lower restitution, a bit more friction) than the world's default
        // so props settle instead of bouncing/sliding forever, with a
        // slightly livelier bounce specifically against the ball so a push
        // reads as an actual impact rather than the prop just absorbing it.
        //
        // Critically, this ALSO registers movable-vs-movable (prop-on-prop)
        // contact explicitly. Leaving that pair unregistered was the actual
        // cause of props tunneling through the floor: cannon-es falls back
        // to world.defaultContactMaterial for any pair without an explicit
        // ContactMaterial, and this world's default restitution is 0.9
        // (tuned for the ball bouncing off walls) — meaning every prop
        // resting against another prop (e.g. a stacked tower) was bouncing
        // off its neighbors almost elastically. In a tightly packed stack
        // that compounds every step into a violent, unstable pile that the
        // solver can't converge on, and it's exactly that kind of
        // under-converged step that lets a body's corrective velocity spike
        // hard enough to pass clean through the (single-sided, no-thickness)
        // floor trimesh before the next step's collision check would have
        // caught it.
        this.movableMaterial = new CANNON.Material("movable");
        const contactBase = { friction: MOVABLE_FRICTION, contactEquationStiffness: 1e8, contactEquationRelaxation: 3 };
        world.addContactMaterial(new CANNON.ContactMaterial(this.movableMaterial, floorMaterial, { ...contactBase, restitution: MOVABLE_RESTITUTION }));
        world.addContactMaterial(new CANNON.ContactMaterial(this.movableMaterial, wallMaterial, { ...contactBase, restitution: MOVABLE_RESTITUTION }));
        world.addContactMaterial(new CANNON.ContactMaterial(this.movableMaterial, ballMaterial, { ...contactBase, restitution: MOVABLE_BALL_RESTITUTION }));
        world.addContactMaterial(new CANNON.ContactMaterial(this.movableMaterial, this.movableMaterial, { ...contactBase, restitution: MOVABLE_RESTITUTION }));
    }

    // Called once from levelLoader right after the GLB has loaded and been
    // added to the scene. Scans the WHOLE level root for any node whose
    // name STARTS WITH "MovableObjectSection" rather than doing a single
    // root.getObjectByName() exact-match lookup — that would only ever
    // return the first hit, and would also silently miss any section
    // Blender's GLTF export auto-renamed to avoid a duplicate name (e.g.
    // "MovableObjectSection.001").
    setup(root) {
        const sectionNodes = [];
        root.traverse((child) => {
            if (MOVABLE_SECTION_PATTERN.test(child.name)) sectionNodes.push(child);
        });

        if (sectionNodes.length === 0) {
            console.warn('No node matching "MovableObjectSection*" found — skipping movable objects.');
            return;
        }

        for (const sectionNode of sectionNodes) {
            // Direct-children prefix match, not getObjectByName() — see
            // MOVABLE_OBJECTS_GROUP_PATTERN's comment in config.js for why
            // an exact match silently breaks on every section after the
            // first (three.js's loader auto-suffixes the *inner* group
            // names too, not just the section names).
            const objectsRoot = sectionNode.children.find((c) => MOVABLE_OBJECTS_GROUP_PATTERN.test(c.name));
            const triggerNode = sectionNode.children.find((c) => MOVABLE_RESET_TRIGGER_PATTERN.test(c.name));
            const section = { objects: [], trigger: null, inside: false };

            if (objectsRoot) {
                // Snapshot the mesh list before reparenting anything below
                // (see _createMovableObject) — traversing a subtree while
                // mutating it out from under itself is unsafe.
                const meshes = [];
                objectsRoot.traverse((child) => {
                    if (child.isMesh) meshes.push(child);
                });
                for (const mesh of meshes) {
                    section.objects.push(this._createMovableObject(mesh));
                }
            } else {
                console.warn(`"${sectionNode.name}": no "MovableObjects*" group found — nothing to make movable.`);
            }

            if (triggerNode) {
                section.trigger = this._createResetTrigger(triggerNode);
            } else {
                console.warn(`"${sectionNode.name}": no "MovableObjectResetTrigger*" found — this section can never be reset.`);
            }

            this.sections.push(section);
        }
    }

    // Builds a dynamic physics body for one authored Cube/Sphere prop, and
    // reparents the mesh directly onto the scene — scene.attach() preserves
    // its current world transform by rewriting its local
    // position/quaternion/scale — so driving it with the body's own
    // world-space position/quaternion every frame (same pattern ball.js
    // uses for ballMesh) doesn't fight whatever local offset its old
    // "MovableObjects" parent group had.
    //
    // Every prop gets a CANNON.Sphere collider, even the visually-cube
    // ones — see MOVABLE_RADIUS_SHRINK's comment in config.js for why:
    // cannon-es can only collide a Sphere (never a Box) against this
    // level's Trimesh Floor/Walls, so a Box collider here would silently
    // never touch them at all. The radius is the geometry's smallest
    // half-extent (an INSCRIBED sphere, not the bounding/circumscribed
    // one) so a resting cube's visual bottom face lines up flush with the
    // real floor instead of floating above it.
    _createMovableObject(mesh) {
        mesh.updateWorldMatrix(true, false);

        const worldPos = new THREE.Vector3();
        const worldQuat = new THREE.Quaternion();
        const worldScale = new THREE.Vector3();
        mesh.matrixWorld.decompose(worldPos, worldQuat, worldScale);

        mesh.geometry.computeBoundingBox();
        const size = new THREE.Vector3();
        mesh.geometry.boundingBox.getSize(size);
        const halfExtents = new THREE.Vector3(
            (size.x / 2) * worldScale.x,
            (size.y / 2) * worldScale.y,
            (size.z / 2) * worldScale.z
        );
        const radius = Math.min(halfExtents.x, halfExtents.y, halfExtents.z) * MOVABLE_RADIUS_SHRINK;

        const body = new CANNON.Body({
            mass: MOVABLE_MASS,
            shape: new CANNON.Sphere(radius),
            material: this.movableMaterial,
            linearDamping: MOVABLE_LINEAR_DAMPING,
            angularDamping: MOVABLE_ANGULAR_DAMPING,
            // Explicit rather than relying on the world-level setting
            // (physicsWorld.js sets world.allowSleep = false already, but
            // per-body defaults to true) — a sleeping prop wouldn't notice
            // its position/velocity being overwritten by _resetSection().
            allowSleep: false,
        });
        body.position.copy(worldPos);
        body.quaternion.copy(worldQuat);
        this.world.addBody(body);

        this.scene.attach(mesh);
        mesh.castShadow = true;
        mesh.receiveShadow = true;

        return {
            mesh,
            body,
            initialPosition: worldPos.clone(),
            initialQuaternion: worldQuat.clone(),
        };
    }

    // Builds the trigger's world-space bounds (same Box3-from-geometry +
    // ball-radius-expand pattern GameModeManager uses for StartTrigger/
    // EndTrigger) plus a discoverability glow — HotspotSystem's
    // "swap every mesh under this node onto an emissive/bloom material"
    // trick (_setupGlow), just in amber instead of GLOW_COLOR's blue so it
    // reads as a distinct "utility" marker rather than another neon hotspot.
    _createResetTrigger(triggerNode) {
        triggerNode.visible = true;

        const box = new THREE.Box3()
            .setFromObject(triggerNode)
            .expandByScalar(BALL_RADIUS + TRIGGER_EXPAND);

        const worldPosition = new THREE.Vector3();
        triggerNode.getWorldPosition(worldPosition);

        const popupAnchor = worldPosition.clone();
        popupAnchor.y += MOVABLE_RESET_POPUP_HEIGHT;

        const meshes = [];
        if (triggerNode.isMesh) meshes.push(triggerNode);
        triggerNode.traverse((child) => {
            if (child.isMesh && child !== triggerNode) meshes.push(child);
        });

        const glowMaterials = [];
        for (const mesh of meshes) {
            const mat = new THREE.MeshStandardMaterial({
                color: MOVABLE_RESET_GLOW_COLOR,
                emissive: MOVABLE_RESET_GLOW_COLOR,
                emissiveIntensity: 1.6,
                roughness: 0.3,
                metalness: 0,
                toneMapped: false, // let emissive push past 1.0 and actually read as "hot"
            });
            mesh.material = mat;
            mesh.castShadow = false;
            mesh.receiveShadow = false;
            mesh.layers.enable(BLOOM_LAYER);
            glowMaterials.push(mat);
        }

        return { node: triggerNode, box, worldPosition, popupAnchor, glowMaterials };
    }

    // Every frame from the main loop: syncs every prop's mesh to its body,
    // pulses the trigger glow (same breathing curve as GlowPath/
    // HotspotSystem), and checks — per section — whether the ball has just
    // rolled onto its trigger.
    update(ballPosition, elapsed) {
        const pulse = 0.5 + Math.sin(elapsed * 2.2) * 0.5; // 0 -> 1
        const intensity = 2.2 + pulse * 1.2;

        for (const section of this.sections) {
            for (const obj of section.objects) {
                // Safety clamp (see MOVABLE_MAX_LINEAR_SPEED's comment in
                // config.js) — belt-and-suspenders against a stack ever
                // punching a prop through the floor even under an
                // under-converged solver step.
                const v = obj.body.velocity;
                const speed = v.length();
                if (speed > MOVABLE_MAX_LINEAR_SPEED) v.scale(MOVABLE_MAX_LINEAR_SPEED / speed, v);
                const w = obj.body.angularVelocity;
                const angSpeed = w.length();
                if (angSpeed > MOVABLE_MAX_ANGULAR_SPEED) w.scale(MOVABLE_MAX_ANGULAR_SPEED / angSpeed, w);

                obj.mesh.position.copy(obj.body.position);
                obj.mesh.quaternion.copy(obj.body.quaternion);
            }

            if (!section.trigger) continue;
            for (const mat of section.trigger.glowMaterials) mat.emissiveIntensity = intensity;

            // Only one confirmation can be up at a time (the ball can only
            // be in one place at once) — leave any other section's
            // hysteresis flag alone until this one is resolved.
            if (this.activeSection && this.activeSection !== section) continue;

            const inside = section.trigger.box.containsPoint(ballPosition);
            if (inside && !section.inside && !this.activeSection) {
                this._openConfirm(section);
            }
            section.inside = inside;
        }
    }

    _openConfirm(section) {
        this.activeSection = section;
        this.player.setFrozen(true);
        this.ui.show(section.trigger.popupAnchor, {
            onConfirm: () => this._resolve(section, true),
            onCancel: () => this._resolve(section, false),
        });
    }

    _resolve(section, shouldReset) {
        if (shouldReset) this._resetSection(section);
        this.ui.hide();
        this.player.setFrozen(false);
        this.activeSection = null;
    }

    // Snaps every object in `section` back to the transform it was
    // authored with, and kills any residual velocity/spin so it doesn't
    // immediately go tumbling off again the instant physics resumes.
    _resetSection(section) {
        for (const obj of section.objects) {
            obj.body.position.copy(obj.initialPosition);
            obj.body.quaternion.copy(obj.initialQuaternion);
            obj.body.velocity.set(0, 0, 0);
            obj.body.angularVelocity.set(0, 0, 0);
        }
    }
}
