import * as THREE from "three";
import { createGlowShellMaterial } from "./glowPath.js";
import {
    BLOOM_LAYER,
    ENTRANCE_BEAM_RADIUS,
    ENTRANCE_BEAM_HEIGHT,
    ENTRANCE_BEAM_COLOR,
    ENTRANCE_DESCEND_DURATION,
    ENTRANCE_HOLD_DURATION,
    ENTRANCE_RETRACT_DURATION,
    ENTRANCE_RING_DURATION,
    ENTRANCE_RING_MAX_SCALE,
} from "./config.js";

function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
}

function easeInCubic(t) {
    return t * t * t;
}

export { easeOutCubic, easeInCubic };

// Builds one independent set of beam + ring visuals (the "spawn beam" look)
// and adds them to `scene`, already hidden. Shared by PlayerEntrance and
// PlayerExit (see playerExit.js) so the exit's reverse-beam effect reads as
// the exact same visual, just played the other way around and triggered by
// a route trigger instead of level load. Each caller gets its OWN beam/ring
// meshes (not a shared instance) — same reasoning as GlowPath/brandGlow
// being separate instances rather than one shared one, so an in-progress
// entrance and an in-progress exit (edge case: a dev-tool teleport firing
// right as the player also confirms a route trigger) can never fight over
// the same THREE.Group's scale/position.
export function createEntranceBeamVisuals(scene) {
    const height = ENTRANCE_BEAM_HEIGHT;
    const radius = ENTRANCE_BEAM_RADIUS;

    const beamPivot = new THREE.Group();
    beamPivot.visible = false;
    scene.add(beamPivot);

    // Bright emissive core — the "solid" part of the beam, picked up by
    // BloomRenderer's selective bloom pass the same way GlowPath's neon
    // meshes are (see glowPath.js).
    const coreGeometry = new THREE.CylinderGeometry(radius * 0.35, radius * 0.35, height, 24, 1, true);
    coreGeometry.translate(0, -height / 2, 0); // top edge at local y = 0
    const coreMaterial = new THREE.MeshBasicMaterial({
        color: ENTRANCE_BEAM_COLOR,
        transparent: true,
        opacity: 0.9,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
    });
    const coreMesh = new THREE.Mesh(coreGeometry, coreMaterial);
    coreMesh.layers.enable(BLOOM_LAYER);
    beamPivot.add(coreMesh);

    // Soft outer shell at the full requested radius — a Fresnel/rim
    // material (same helper GlowPath uses for its optional halo shells) so
    // it's brightest at the silhouette and fades toward the center, giving
    // the beam volume instead of a flat glowing tube.
    const shellGeometry = new THREE.CylinderGeometry(radius, radius, height, 32, 1, true);
    shellGeometry.translate(0, -height / 2, 0);
    const shellMaterial = createGlowShellMaterial(ENTRANCE_BEAM_COLOR, 0.55, 1.6);
    const shellMesh = new THREE.Mesh(shellGeometry, shellMaterial);
    shellMesh.layers.enable(BLOOM_LAYER);
    beamPivot.add(shellMesh);

    // Flat impact-flash ring, laid on the floor, triggered the instant the
    // beam reaches the ground. Pure additive glow, no geometry depth, so it
    // reads as a quick pulse of light rather than a physical object.
    const ringGeometry = new THREE.RingGeometry(0.6, 1, 48);
    const ringMaterial = new THREE.MeshBasicMaterial({
        color: ENTRANCE_BEAM_COLOR,
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
    });
    const ring = new THREE.Mesh(ringGeometry, ringMaterial);
    ring.rotation.x = -Math.PI / 2;
    ring.visible = false;
    ring.layers.enable(BLOOM_LAYER);
    scene.add(ring);

    return { beamPivot, coreMesh, shellMesh, ring };
}

// Plays the one-time "spawn beam" entrance: the ball starts invisible and
// frozen (see hidePlayer(), called immediately once the ball/player exist —
// well before either the level or the ball model have finished loading), a
// cylindrical beam of light drops onto the spawn point, the ball pops in
// at its base the instant the beam touches down, then the beam retracts
// back up and disappears — at which point the player regains control.
//
// The beam is a THREE.Group ("beamPivot") pinned at a fixed world height
// (spawnY + ENTRANCE_BEAM_HEIGHT) whose scale.y is animated 0 -> 1 -> 0.
// The cylinder mesh inside it is offset so its TOP edge sits at the
// group's local origin — scaling the group therefore grows/shrinks the
// beam downward from that fixed top point (rather than from its own
// center), which is what makes it read as "coming down out of the sky"
// and "rising back up and disappearing" instead of just stretching in
// place.
export class PlayerEntrance {
    constructor(scene, audioManager = null) {
        this.scene = scene;
        this.audioManager = audioManager;
        this.state = "idle"; // idle -> descend -> hold -> retract -> done
        this.elapsed = 0;
        this.ballMesh = null;
        this.player = null;

        const { beamPivot, coreMesh, shellMesh, ring } = createEntranceBeamVisuals(scene);
        this.beamPivot = beamPivot;
        this.coreMesh = coreMesh;
        this.shellMesh = shellMesh;
        this.ring = ring;
        this.ringActive = false;
        this.ringElapsed = 0;
    }

    // Call once, as soon as the ball mesh + PlayerController exist (main.js
    // does this right after both are constructed, well before the level or
    // ball model have actually finished loading) — makes the ball invisible
    // and locks out input so nothing is on screen or movable until play()
    // runs the reveal.
    hidePlayer(ballMesh, player) {
        this.ballMesh = ballMesh;
        this.player = player;
        ballMesh.visible = false;
        player.setFrozen(true);
    }

    // Starts the beam-drop -> spawn -> retract sequence at spawnPosition
    // (a THREE.Vector3, world space — the same point the ball itself was
    // placed at). Call once the level AND the ball model are both ready.
    play(spawnPosition) {
        this.spawnPosition = spawnPosition.clone();

        this.beamPivot.position.set(
            this.spawnPosition.x,
            this.spawnPosition.y + ENTRANCE_BEAM_HEIGHT,
            this.spawnPosition.z
        );
        this.beamPivot.scale.set(1, 0.0001, 1);
        this.beamPivot.visible = true;

        this.ring.position.set(this.spawnPosition.x, this.spawnPosition.y + 0.03, this.spawnPosition.z);
        this.ring.visible = false;
        this.ringActive = false;

        this.state = "descend";
        this.elapsed = 0;
    }

    _onBeamReachedFloor() {
        // The moment of arrival — reveal the player and pop the ground
        // flash. Player regains control later, once the beam has fully
        // retracted (see _onFinished).
        if (this.ballMesh) this.ballMesh.visible = true;
        if (this.audioManager) this.audioManager.playWarpSound();
        this.ring.visible = true;
        this.ring.material.opacity = 1;
        this.ring.scale.setScalar(0.3);
        this.ringActive = true;
        this.ringElapsed = 0;
    }

    _updateRing(dt) {
        if (!this.ringActive) return;
        this.ringElapsed += dt;
        const t = Math.min(this.ringElapsed / ENTRANCE_RING_DURATION, 1);
        const eased = easeOutCubic(t);
        const scale = 0.3 + eased * (ENTRANCE_RING_MAX_SCALE - 0.3);
        this.ring.scale.setScalar(scale);
        this.ring.material.opacity = 1 - eased;
        if (t >= 1) {
            this.ringActive = false;
            this.ring.visible = false;
        }
    }

    _onFinished() {
        this.beamPivot.visible = false;
        this.state = "done";
        if (this.player) this.player.setFrozen(false);
    }

    // Called every frame from the main loop. No-op once idle/done, so it's
    // always safe to call unconditionally.
    update(dt, elapsedTime) {
        if (this.ringActive) this._updateRing(dt);

        if (this.state === "idle" || this.state === "done") return;

        this.elapsed += dt;

        // Gentle high-frequency flicker on top of the base opacity so the
        // beam doesn't read as a flat, static shape while it's held open.
        const flicker = 0.9 + Math.sin(elapsedTime * 40) * 0.05;
        this.coreMesh.material.opacity = 0.9 * flicker;

        switch (this.state) {
            case "descend": {
                const t = Math.min(this.elapsed / ENTRANCE_DESCEND_DURATION, 1);
                this.beamPivot.scale.y = Math.max(easeOutCubic(t), 0.0001);
                if (t >= 1) {
                    this._onBeamReachedFloor();
                    this.state = "hold";
                    this.elapsed = 0;
                }
                break;
            }
            case "hold": {
                if (this.elapsed >= ENTRANCE_HOLD_DURATION) {
                    this.state = "retract";
                    this.elapsed = 0;
                }
                break;
            }
            case "retract": {
                const t = Math.min(this.elapsed / ENTRANCE_RETRACT_DURATION, 1);
                this.beamPivot.scale.y = Math.max(1 - easeInCubic(t), 0.0001);
                if (t >= 1) {
                    this._onFinished();
                }
                break;
            }
        }
    }
}
