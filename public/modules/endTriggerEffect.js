import * as THREE from "three";
import {
    GLOW_COLOR,
    BLOOM_LAYER,
    END_RING_COUNT,
    END_RING_GAP,
    END_RING_CYCLE_DURATION,
    END_RING_THICKNESS_RATIO,
    END_RING_BASE_OPACITY,
    END_WALL_HEIGHT,
    END_WALL_OPACITY,
    END_WALL_EMISSIVE_INTENSITY,
} from "./config.js";

// Decorative-only (no physics) finish-line effect built around EndTrigger:
//
//  - EndTrigger's own mesh gets the same glowing core material GlowPath
//    uses instead of staying invisible, with the same breathing pulse.
//  - Three concentric rings pulse inward: each shrinks from an outer
//    spawn radius toward the center while fading out, and the instant one
//    fully collapses a fresh ring spawns back at the outer edge — an
//    infinite "energy converging on the finish" loop. The three are phase-
//    offset by a third of the cycle so there are always three on screen at
//    different stages, matching the "increasing diameter further out,
//    0.15m gaps" resting arrangement (object edge -> +0.15 -> +0.15 ->
//    +0.15).
//  - A tall, mostly-transparent neon-blue cylinder wall — matching
//    EndTrigger's own circular footprint — marks the finish column from
//    the trigger's base up to END_WALL_HEIGHT meters. It carries a slight
//    bloom (emissive intensity just above the bloom threshold, low
//    opacity) so it reads as a faint glowing boundary rather than
//    competing with the ring animation for attention.
//
// The core, rings, AND wall are all flagged onto BLOOM_LAYER so
// BloomRenderer's selective bloom pass picks them up like GlowPath's
// meshes - the wall's glow is just much subtler due to its low
// emissive intensity/opacity.
export class EndTriggerEffect {
    constructor() {
        this.rings = []; // { mesh, phaseOffset }
        this.coreMaterial = null;
        this.wallMesh = null;
        this.baseRadius = 0;
        this.center = new THREE.Vector3();
        this.baseY = 0;
    }

    setup(endTriggerMesh, scene) {
        // EndTrigger's footprint is a cylinder in the source art — read its
        // world-space bounding box rather than assuming local dimensions,
        // since it's scaled non-uniformly by its parent nodes.
        const box = new THREE.Box3().setFromObject(endTriggerMesh);
        const size = new THREE.Vector3();
        box.getSize(size);
        box.getCenter(this.center);

        this.baseRadius = Math.max(size.x, size.z) / 2;
        this.baseY = box.min.y;

        // ── EndTrigger itself: same glow-core look as GlowPath ──
        endTriggerMesh.visible = true;
        endTriggerMesh.castShadow = false;
        endTriggerMesh.receiveShadow = false;
        this.coreMaterial = new THREE.MeshStandardMaterial({
            color: GLOW_COLOR,
            emissive: GLOW_COLOR,
            emissiveIntensity: 1.6,
            roughness: 0.3,
            metalness: 0,
            toneMapped: false, // let emissive push past 1.0 and actually read as "hot"
        });
        endTriggerMesh.material = this.coreMaterial;
        endTriggerMesh.layers.enable(BLOOM_LAYER);

        // ── Pulsating rings ──
        // A flat unit ring (radius 1) built once, lain flat on the XZ
        // plane, then scaled per-frame to the current animated radius —
        // cheaper than rebuilding geometry every frame, at the cost of the
        // ring's line thickness scaling along with it (reads fine in
        // practice, similar to a lock-on/portal reticle).
        const ringGeo = new THREE.RingGeometry(1 - END_RING_THICKNESS_RATIO, 1, 64);
        for (let i = 0; i < END_RING_COUNT; i++) {
            const mat = new THREE.MeshStandardMaterial({
                color: GLOW_COLOR,
                emissive: GLOW_COLOR,
                emissiveIntensity: 2.4,
                roughness: 0.3,
                metalness: 0,
                transparent: true,
                opacity: END_RING_BASE_OPACITY,
                side: THREE.DoubleSide,
                depthWrite: false,
                toneMapped: false,
            });
            const mesh = new THREE.Mesh(ringGeo, mat);
            mesh.rotation.x = -Math.PI / 2; // lie flat on the ground (XZ), same convention as fog.js's plane
            // Tiny lift off the floor so the ring doesn't z-fight with
            // whatever collision mesh it's resting on.
            mesh.position.set(this.center.x, this.baseY + 0.01, this.center.z);
            mesh.layers.enable(BLOOM_LAYER);
            mesh.renderOrder = 1;
            scene.add(mesh);
            this.rings.push({ mesh, phaseOffset: i / END_RING_COUNT });
        }

        // ── Cylindrical finish-column wall ──
        // Open-ended (no top/bottom caps) so it reads as a hollow wall
        // standing on the trigger's footprint rather than a solid drum.
        const wallGeo = new THREE.CylinderGeometry(
            this.baseRadius,
            this.baseRadius,
            END_WALL_HEIGHT,
            48,
            1,
            true
        );
        const wallMat = new THREE.MeshStandardMaterial({
            // Back to an emissive material (unlike the plain MeshBasicMaterial
            // used earlier) so BLOOM_LAYER can pick it up - but intensity is
            // kept only just above the bloom pass's threshold (see
            // END_WALL_EMISSIVE_INTENSITY in config.js) plus a low opacity,
            // so the glow reads as slight/faint rather than matching the
            // core/rings' full bloom strength.
            color: GLOW_COLOR,
            emissive: GLOW_COLOR,
            emissiveIntensity: END_WALL_EMISSIVE_INTENSITY,
            roughness: 0.3,
            metalness: 0,
            transparent: true,
            opacity: END_WALL_OPACITY,
            side: THREE.DoubleSide,
            depthWrite: false,
            toneMapped: false,
        });
        this.wallMesh = new THREE.Mesh(wallGeo, wallMat);
        this.wallMesh.position.set(this.center.x, this.baseY + END_WALL_HEIGHT / 2, this.center.z);
        // Slight bloom: enabled on BLOOM_LAYER same as the core/rings, but
        // its low emissiveIntensity + opacity keep the resulting glow subtle.
        this.wallMesh.layers.enable(BLOOM_LAYER);
        scene.add(this.wallMesh);
    }

    // Swaps the core, all three rings, and the finish-column wall over to
    // `color` — used by GameModeManager to flip EndTrigger red while a
    // Collection Time Trial run is short on orbs, and back to GLOW_COLOR
    // once all orbs are collected.
    setColor(color) {
        if (this.coreMaterial) {
            this.coreMaterial.color.set(color);
            this.coreMaterial.emissive.set(color);
        }
        for (const ring of this.rings) {
            ring.mesh.material.color.set(color);
            ring.mesh.material.emissive.set(color);
        }
        if (this.wallMesh) {
            this.wallMesh.material.color.set(color);
            this.wallMesh.material.emissive.set(color);
        }
    }

    // Called every frame once setup() has run (levelLoader may still be
    // mid-load on earlier frames, hence the rings-length guard).
    update(elapsed) {
        if (!this.rings.length) return;

        // Same breathing pulse style/range as GlowPath, applied to the
        // EndTrigger core itself so it doesn't look static next to the
        // animated rings.
        const pulse = 0.5 + Math.sin(elapsed * 2.2) * 0.5; // 0 -> 1
        if (this.coreMaterial) {
            this.coreMaterial.emissiveIntensity = 2.2 + pulse * 1.2;
        }

        const outerRadius = this.baseRadius + END_RING_GAP * END_RING_COUNT;
        // Floor so a ring never shrinks to an exact zero-size/zero-opacity
        // scale — keeps all END_RING_COUNT rings genuinely on screen (just
        // faint/tiny) at every instant instead of blinking out for a frame
        // right as the cycle wraps and the next ring takes over.
        const MIN_VISIBLE_FRACTION = 0.02;

        for (const ring of this.rings) {
            // t: 0 = just spawned at outerRadius/full opacity, 1 = fully
            // collapsed to the center/faded to near-invisible. Modulo makes
            // each ring loop forever; the phaseOffset staggers the three
            // so a new one is always taking over as another vanishes -
            // guaranteeing 3 rings are present at all times.
            const t = ((elapsed / END_RING_CYCLE_DURATION) + ring.phaseOffset) % 1;
            const remaining = Math.max(1 - t, MIN_VISIBLE_FRACTION);
            const radius = outerRadius * remaining;
            const opacity = END_RING_BASE_OPACITY * remaining;

            ring.mesh.scale.set(radius, radius, 1);
            ring.mesh.material.opacity = opacity;
            ring.mesh.visible = true;
        }
    }
}