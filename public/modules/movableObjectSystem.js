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
    MOVABLE_BALL_FRICTION,
    MOVABLE_RESTITUTION,
    MOVABLE_BALL_RESTITUTION,
    MOVABLE_MAX_LINEAR_SPEED,
    MOVABLE_MAX_ANGULAR_SPEED,
    MOVABLE_SLEEP_SPEED_LIMIT,
    MOVABLE_SLEEP_TIME_LIMIT,
    MOVABLE_RADIUS_SHRINK,
    MOVABLE_MIN_RADIUS_FACTOR,
    MOVABLE_COLLISION_GROUP,
    MOVABLE_RESET_POPUP_HEIGHT,
    MOVABLE_RESET_GLOW_COLOR,
    MOVABLE_GROUND_CHECK_TOLERANCE,
    MOVABLE_GROUND_CHECK_MAX_RETRIES,
    MOVABLE_GROUND_CHECK_NUDGE,
    MOVABLE_WATCHDOG_CHECKS_PER_FRAME,
} from "./config.js";

// Owns every "MovableObjectSection" authored in the level GLB: a group of
// gravity-affected, ball-pushable props (its "MovableObjects" children) plus
// a sibling "MovableObjectResetTrigger" cylinder that, once rolled onto,
// asks — via MovableObjectBillboard's world-anchored "Press Enter to Reset"
// panel — whether to snap that section's props back to their authored
// positions. Any number of sections
// can be authored (currently two); each only ever resets its own objects,
// same isolation GameModeManager's Start/EndTrigger pair doesn't need but
// HotspotSystem's per-node registration already models well.
export class MovableObjectSystem {
    constructor({ scene, world, floorMaterial, wallMaterial, ballMaterial, ui }) {
        this.scene = scene;
        this.world = world;
        this.ui = ui;

        this.sections = []; // { objects: [{mesh,body,initialPosition,initialQuaternion}], trigger: {...}|null, inside }
        this.activeSection = null; // the one section currently showing its confirmation, or null

        // Flat view across every section's objects, built once in setup()
        // — used only by the round-robin watchdog sweep below, which
        // doesn't care which section an object belongs to.
        this.allObjects = [];
        this._watchdogCursor = 0;

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
        const contactBase = { contactEquationStiffness: 1e8, contactEquationRelaxation: 3 };
        world.addContactMaterial(new CANNON.ContactMaterial(this.movableMaterial, floorMaterial, { ...contactBase, friction: MOVABLE_FRICTION, restitution: MOVABLE_RESTITUTION }));
        world.addContactMaterial(new CANNON.ContactMaterial(this.movableMaterial, wallMaterial, { ...contactBase, friction: MOVABLE_FRICTION, restitution: MOVABLE_RESTITUTION }));
        world.addContactMaterial(new CANNON.ContactMaterial(this.movableMaterial, ballMaterial, { ...contactBase, friction: MOVABLE_BALL_FRICTION, restitution: MOVABLE_BALL_RESTITUTION }));
        world.addContactMaterial(new CANNON.ContactMaterial(this.movableMaterial, this.movableMaterial, { ...contactBase, friction: MOVABLE_FRICTION, restitution: MOVABLE_RESTITUTION }));
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

                // Precompute each mesh's distance to its nearest neighbor
                // BEFORE creating any bodies, so _createMovableObject can
                // cap how far it's allowed to grow the collision radius for
                // pushability (see MOVABLE_MIN_RADIUS_FACTOR in config.js).
                // Without this cap, tightly packed props (e.g. a stacked
                // tower where neighbors sit ~0.35m apart) would end up with
                // radii that overlap their neighbors by nearly double the
                // instant they're created, and the solver "explodes" the
                // whole stack apart on the very first frame trying to
                // resolve all that interpenetration at once.
                const worldPositions = meshes.map((mesh) => {
                    mesh.updateWorldMatrix(true, false);
                    const pos = new THREE.Vector3();
                    mesh.getWorldPosition(pos);
                    return pos;
                });
                const nearestNeighborDistances = worldPositions.map((pos, i) => {
                    let nearest = Infinity;
                    for (let j = 0; j < worldPositions.length; j++) {
                        if (j === i) continue;
                        nearest = Math.min(nearest, pos.distanceTo(worldPositions[j]));
                    }
                    return nearest;
                });

                for (let i = 0; i < meshes.length; i++) {
                    section.objects.push(this._createMovableObject(meshes[i], nearestNeighborDistances[i]));
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

        for (const section of this.sections) this.allObjects.push(...section.objects);
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
    // one), floored at roughly BALL_RADIUS for pushability (see
    // MOVABLE_MIN_RADIUS_FACTOR's comment) — but capped at just under half
    // of `nearestNeighborDistance` so that floor-raise can never make two
    // neighboring props overlap more than they were authored to. Without
    // that cap, tightly packed props (e.g. a stacked tower with ~0.35m
    // spacing) would all suddenly overlap their neighbors by nearly double
    // the instant they're created, and the very first physics step would
    // "explode" the whole stack apart trying to resolve it.
    _createMovableObject(mesh, nearestNeighborDistance = Infinity) {
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
        const inscribedRadius = Math.min(halfExtents.x, halfExtents.y, halfExtents.z) * MOVABLE_RADIUS_SHRINK;
        const desiredRadius = Math.max(inscribedRadius, BALL_RADIUS * MOVABLE_MIN_RADIUS_FACTOR);
        // 0.48 rather than 0.5 leaves a small safety gap instead of exactly
        // touching, which avoids day-one jitter from floating-point contact
        // right at the boundary.
        const neighborSafeRadius = Number.isFinite(nearestNeighborDistance) ? nearestNeighborDistance * 0.48 : Infinity;
        const radius = Math.min(desiredRadius, Math.max(neighborSafeRadius, inscribedRadius));

        // A visually round "Sphere" prop should actually roll like one —
        // forcing fixedRotation on every prop (regardless of its real
        // shape) made round props slide across the floor dead straight
        // with no spin at all, which looks wrong for something that's
        // supposed to be a ball. Cube-named props keep fixedRotation so
        // they slide rather than tumble/roll like a ball would.
        const isRoundProp = /sphere/i.test(mesh.name);

        // The collision sphere is floored at BALL_RADIUS for pushability
        // (see MOVABLE_MIN_RADIUS_FACTOR's comment in config.js), which for
        // a short/thin prop can end up noticeably BIGGER than the mesh's
        // real vertical half-extent. Since the mesh is driven straight off
        // the sphere's center every frame, that mismatch reads as the prop
        // permanently hovering above the real floor — physically correct
        // (the sphere really is resting on the floor), but visually wrong.
        // Compensating with a constant downward render offset — applied in
        // update(), physics untouched — keeps the pushability radius intact
        // while putting the visible mesh back flush with the true floor.
        const visualDropOffset = Math.max(0, radius - halfExtents.y);

        const body = new CANNON.Body({
            mass: MOVABLE_MASS,
            shape: new CANNON.Sphere(radius),
            material: this.movableMaterial,
            linearDamping: MOVABLE_LINEAR_DAMPING,
            angularDamping: MOVABLE_ANGULAR_DAMPING,
            fixedRotation: !isRoundProp,
            // See MOVABLE_SLEEP_SPEED_LIMIT's comment in config.js — this
            // is the actual fix for the FPS drop when props start moving:
            // getting them back to sleep quickly once they stop matters far
            // more than anything about how the physics itself is tuned.
            sleepSpeedLimit: MOVABLE_SLEEP_SPEED_LIMIT,
            sleepTimeLimit: MOVABLE_SLEEP_TIME_LIMIT,
            // Left at its default (true) rather than forced false — see
            // physicsWorld.js's world.allowSleep comment for why letting
            // props sleep once they settle matters a lot for performance.
            // _resetSection() calls body.wakeUp() explicitly, so a sleeping
            // prop still responds correctly the moment it's reset.
        });
        body.position.copy(worldPos);
        body.quaternion.copy(worldQuat);
        // Tagged so playerController's wall-bounce/sound handler (see its
        // _onCollide) can tell "hit a movable prop" apart from "hit a real
        // wall". Both are physically Sphere-vs-Sphere-ish contacts with a
        // similarly horizontal normal now that props are ball-sized (see
        // MOVABLE_MIN_RADIUS_FACTOR), so without this tag every push
        // registered as a wall impact: repeated bounce sounds, and the
        // wall-hit velocity blend actively fighting the push, which is
        // most of why pushing ever felt "heavy" or "sticky" in the first
        // place — that was game-feel code layered on top of the physics,
        // not the physics itself.
        body.isMovableProp = true;
        // Its own collision-filter bit (see MOVABLE_COLLISION_GROUP's
        // comment in config.js) — used ONLY by playerController.js's
        // ground-detection raycast to specifically ignore props, so the
        // ball stops reading "standing next to a prop" as "standing on a
        // ramp" and climbing it. Doesn't touch physical collision at all:
        // every other body's mask is left at its default (-1, matches
        // everything), so pushing/resting/contact with props works exactly
        // as before.
        body.collisionFilterGroup = MOVABLE_COLLISION_GROUP;
        this.world.addBody(body);

        this.scene.attach(mesh);
        mesh.castShadow = true;
        mesh.receiveShadow = true;

        const obj = {
            mesh,
            body,
            radius,
            visualDropOffset,
            initialPosition: worldPos.clone(),
            initialQuaternion: worldQuat.clone(),
            groundCheckRetries: 0,
        };

        // The actual fix for props freezing mid-air: cannon-es puts a body
        // to sleep purely from ITS OWN speed dropping below
        // MOVABLE_SLEEP_SPEED_LIMIT for MOVABLE_SLEEP_TIME_LIMIT seconds —
        // it never checks whether anything is actually underneath it. A
        // tightly packed group of props (this level's stacks/rows) is
        // exactly the case where that assumption breaks: a prop can end up
        // momentarily "wedged" — held nearly still by friction against its
        // neighbors, sometimes just from a slightly-under-converged solver
        // step (30 iterations isn't infinite) — for long enough to cross
        // that speed/time threshold before it has actually reached the
        // floor. cannon-es then stops integrating it entirely, so gravity
        // never gets another chance to finish the job: a visibly floating
        // prop, frozen forever. Every time a prop crosses into SLEEPING we
        // fire one cheap downward raycast to check that's actually true —
        // see _checkGrounded. That catches it going to sleep unsupported,
        // but not a prop whose support gets pulled out from under it
        // AFTER it's already asleep (e.g. a stacked prop resting on top of
        // a DIFFERENT section's prop, which then teleports back to its
        // authored position when that other section is reset — a teleport
        // doesn't collide with anything, so nothing ever wakes the prop
        // sitting on it). update()'s round-robin sweep covers that case by
        // periodically re-checking sleeping props even with no event to
        // trigger it.
        body.addEventListener("sleep", () => this._checkGrounded(obj));

        return obj;
    }

    // Shared by the "sleep" event listener above (immediate, catches a
    // prop settling somewhere it shouldn't) and update()'s round-robin
    // sweep (periodic, catches a prop whose support disappeared after it
    // was already asleep). Casts one short ray straight down from just
    // above the prop to well below the floor; a genuinely-resting prop
    // hits something (the real floor/wall, or another prop it's stacked
    // on) within `radius + tolerance` of itself. If it doesn't — nothing
    // there at all, or the nearest thing is farther below than its own
    // radius plus a small allowance — wake it back up and give it a small
    // extra downward shove so it actually separates from whatever was
    // falsely holding it (or simply falls now that its support is gone)
    // and gets a clean chance to fall and resettle. `collisionResponse` is
    // flipped off for the instant of the cast (the same trick cannon-es's
    // own RaycastVehicle uses to keep a body's ray from hitting itself)
    // since the ray starts inside the prop's own sphere.
    _checkGrounded(obj) {
        const body = obj.body;
        const from = new CANNON.Vec3(body.position.x, body.position.y, body.position.z);
        const to = new CANNON.Vec3(body.position.x, body.position.y - 50, body.position.z);
        const result = new CANNON.RaycastResult();

        const prevResponse = body.collisionResponse;
        body.collisionResponse = false;
        this.world.raycastClosest(from, to, {}, result);
        body.collisionResponse = prevResponse;

        if (result.hasHit) {
            const clearance = body.position.y - result.hitPointWorld.y - obj.radius;
            if (clearance <= MOVABLE_GROUND_CHECK_TOLERANCE) {
                obj.groundCheckRetries = 0;
                return;
            }
        }

        // Cap the retries so a genuinely pathological case (e.g. a prop
        // wedged somewhere a straight-down ray can never resolve) can't
        // turn into an infinite wake/sleep loop burning CPU every cycle —
        // in practice a real false-sleep resolves on the very first retry.
        obj.groundCheckRetries++;
        if (obj.groundCheckRetries > MOVABLE_GROUND_CHECK_MAX_RETRIES) return;

        body.wakeUp();
        body.velocity.y -= MOVABLE_GROUND_CHECK_NUDGE;
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
        this._sweepGroundWatchdog();

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

                obj.mesh.position.set(obj.body.position.x, obj.body.position.y - obj.visualDropOffset, obj.body.position.z);
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
            } else if (!inside && section.inside && this.activeSection === section) {
                // Rolled off the trigger without answering. The player is
                // never frozen here (see _openConfirm's comment), so unlike
                // a modal popup they're free to just leave — auto-dismiss
                // as an implicit "No" rather than leave a stale popup
                // hanging in space with the section stuck as "active"
                // (which would also block the OTHER section's trigger from
                // ever opening until this one is resolved).
                this._resolve(section, false);
            }
            section.inside = inside;
        }
    }

    // A fixed, tiny amount of watchdog work every frame (a handful of
    // raycasts, only against props already asleep) rather than rechecking
    // every sleeping prop every frame — cost stays flat no matter how many
    // props the level has. Cycles through `allObjects` round-robin so
    // every sleeping prop still gets re-verified periodically, catching a
    // prop whose support was pulled out from under it after it fell asleep
    // (see _checkGrounded's comment for the concrete scenario: a different
    // section resetting/teleporting the prop it was resting on).
    _sweepGroundWatchdog() {
        const total = this.allObjects.length;
        if (total === 0) return;

        const checks = Math.min(MOVABLE_WATCHDOG_CHECKS_PER_FRAME, total);
        for (let i = 0; i < checks; i++) {
            const obj = this.allObjects[this._watchdogCursor];
            this._watchdogCursor = (this._watchdogCursor + 1) % total;
            if (obj.body.sleepState === CANNON.Body.SLEEPING) this._checkGrounded(obj);
        }
    }

    _openConfirm(section) {
        this.activeSection = section;
        // Deliberately NOT freezing the player (no player.setFrozen(true))
        // — rolling onto the trigger used to hard-stop the ball the moment
        // the popup appeared, which felt like an abrupt, unintended loss of
        // control. The popup now just floats in on top of normal play; the
        // player can keep rolling, drive away, come back, whatever, and the
        // confirmation stays live until they actually click Yes/No or roll
        // off (see update()'s implicit-cancel-on-leave above).
        this.ui.show(section.trigger.popupAnchor, {
            onConfirm: () => this._resolve(section, true),
            onCancel: () => this._resolve(section, false),
        });
    }

    _resolve(section, shouldReset) {
        if (shouldReset) this._resetSection(section);
        this.ui.hide();
        this.activeSection = null;
    }

    // Snaps every object in `section` back to the transform it was
    // authored with, and kills any residual velocity/spin so it doesn't
    // immediately go tumbling off again the instant physics resumes.
    // wakeUp() matters here specifically because props are now allowed to
    // sleep (see physicsWorld.js) — a sleeping body excluded from the
    // solver wouldn't otherwise notice its position was just changed out
    // from under it.
    _resetSection(section) {
        for (const obj of section.objects) {
            obj.body.wakeUp();
            obj.body.position.copy(obj.initialPosition);
            obj.body.quaternion.copy(obj.initialQuaternion);
            obj.body.velocity.set(0, 0, 0);
            obj.body.angularVelocity.set(0, 0, 0);
            obj.groundCheckRetries = 0;
        }
    }
}
