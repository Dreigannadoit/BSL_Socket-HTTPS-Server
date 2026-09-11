import * as THREE from "three";
import {
    CAMERA_OFFSET,
    HOTSPOT_CAMERA_CONFIGS,
    DEFAULT_HOTSPOT_CAMERA_CONFIG,
    HOTSPOT_CAMERA_BLEND,
    SKID_CAMERA_ROLL,
    SKID_CAMERA_ROLL_SMOOTH,
    SPEED_FOV_BOOST_MAX,
    SPEED_FOV_SMOOTH,
    SPEED_SHAKE_MAX_AMPLITUDE,
    SPEED_SHAKE_FREQUENCY,
} from "./config.js";

export class CameraController {
    constructor(camera) {
        this.camera = camera;
        this.offset = new THREE.Vector3(CAMERA_OFFSET.x, CAMERA_OFFSET.y, CAMERA_OFFSET.z);
        // Scratch vector reused each frame to hold the *active* hotspot's
        // offset (see HOTSPOT_CAMERA_CONFIGS) — which hotspot that is can
        // change frame to frame, so this can't be precomputed once like
        // `offset` above.
        this._hotspotOffset = new THREE.Vector3();
        // The values actually applied each frame — eased toward `offset` /
        // baseFov / 0 normally, or toward the hotspot equivalents while a
        // hotspot is active, rather than snapping between the two.
        this.currentOffset = this.offset.clone();
        this.baseFov = camera.fov;
        this.currentFov = camera.fov;
        this.currentTargetYOffset = 0;

        this.target = new THREE.Vector3();
        // Smoothed separately from the raw skid intensity so it eases out.
        this.skidRoll = 0;

        // Speed-feel state: currentSpeedFov eases toward the FOV kick like
        // currentFov eases toward hotspot FOV; _shakeOffset is recomputed
        // fresh each frame (no easing needed — it's already a smooth
        // continuous function of elapsed time).
        this.currentSpeedFov = 0;
        this._shakeOffset = new THREE.Vector3();
    }

    // `player` is the PlayerController — its reversalTimer/reversalDuration
    // and prevTargetX drive the skid-lean feedback. `activeHotspot` comes
    // from HotspotSystem (its `activeHotspot` field — { name, position, ... }
    // or null): while set, the camera eases into that hotspot's own
    // tighter/wider-FOV framing (HOTSPOT_CAMERA_CONFIGS[activeHotspot.name],
    // falling back to DEFAULT_HOTSPOT_CAMERA_CONFIG) looking above the ball
    // instead of straight at it.
    //
    // `manualOverride` (optional) is devTools' camera state: while
    // `manualOverride.lookAtPlayer` is false, this entire follow/lookAt
    // pipeline is skipped and the camera's position/rotation is set
    // directly from `manualOverride.position` (world units) and
    // `manualOverride.rotationRadians` ({x,y,z} radians) instead — that's
    // the devtools "look wherever you like" mode.
    //
    // `elapsed` (seconds, e.g. THREE.Clock.elapsedTime) drives the
    // speed-shake sine waves below — needs a continuously increasing time
    // source, not dt.
    //
    // `speedFxActive` gates the speed FOV kick + shake below — true only
    // while GameModeManager's mode is Speedrun (see main.js's call site).
    // Free Roam/Time Trial never get these regardless of how fast the
    // ball happens to be moving.
    update(ballMesh, player, activeHotspot = null, manualOverride = null, elapsed = 0, speedFxActive = false) {
        if (manualOverride && !manualOverride.lookAtPlayer) {
            const p = manualOverride.position;
            const r = manualOverride.rotationRadians;
            this.camera.position.set(p.x, p.y, p.z);
            this.camera.rotation.set(r.x, r.y, r.z);
            return;
        }

        const isHotspotActive = !!activeHotspot;
        const hotspotConfig = isHotspotActive
            ? HOTSPOT_CAMERA_CONFIGS[activeHotspot.name] || DEFAULT_HOTSPOT_CAMERA_CONFIG
            : null;

        const targetOffset = isHotspotActive
            ? this._hotspotOffset.set(hotspotConfig.offset.x, hotspotConfig.offset.y, hotspotConfig.offset.z)
            : this.offset;
        this.currentOffset.lerp(targetOffset, HOTSPOT_CAMERA_BLEND);

        // How fast the ball is currently going, as a 0-1 fraction of
        // *this mode's* max speed — same normalization AudioManager.update()
        // uses, so the FOV kick, shake, and engine/rolling pitch all ramp
        // in together. Suppressed while a hotspot has taken over framing,
        // or outside Speedrun entirely (speedFxActive).
        const horizSpeed = Math.hypot(player.ballBody.velocity.x, player.ballBody.velocity.z);
        const speedFraction = !isHotspotActive && speedFxActive && player.maxSpeed > 0
            ? THREE.MathUtils.clamp(horizSpeed / player.maxSpeed, 0, 1)
            : 0;

        const targetFov = isHotspotActive
            ? hotspotConfig.fov
            : this.baseFov + speedFraction * SPEED_FOV_BOOST_MAX;
        const fovBlend = isHotspotActive ? HOTSPOT_CAMERA_BLEND : SPEED_FOV_SMOOTH;
        this.currentFov += (targetFov - this.currentFov) * fovBlend;
        if (Math.abs(this.camera.fov - this.currentFov) > 0.01) {
            this.camera.fov = this.currentFov;
            this.camera.updateProjectionMatrix();
        }

        const targetYOffset = isHotspotActive ? hotspotConfig.targetYOffset : 0;
        this.currentTargetYOffset += (targetYOffset - this.currentTargetYOffset) * HOTSPOT_CAMERA_BLEND;

        this.target.copy(ballMesh.position);
        this.target.y += this.currentTargetYOffset;

        const desired = this.target.clone().add(this.currentOffset);

        // Speed shake: small continuous jitter added to the camera's
        // vantage point (not the look target), so it still generally
        // aims at the ball but the shot itself trembles at speed.
        // Deterministic sine waves rather than random jitter — smooth and
        // repeatable rather than a potentially jarring per-frame jump.
        // Different frequency multipliers per axis so it doesn't read as
        // one simple circular wobble.
        if (speedFraction > 0) {
            const amp = speedFraction * SPEED_SHAKE_MAX_AMPLITUDE;
            this._shakeOffset.set(
                Math.sin(elapsed * SPEED_SHAKE_FREQUENCY) * amp,
                Math.sin(elapsed * SPEED_SHAKE_FREQUENCY * 1.7 + 1.3) * amp * 0.6,
                Math.cos(elapsed * SPEED_SHAKE_FREQUENCY * 1.3 + 0.7) * amp
            );
            desired.add(this._shakeOffset);
        }

        this.camera.position.lerp(desired, 1);
        this.camera.lookAt(this.target);

        // Skid feedback: roll the camera while a reversal skid is active,
        // proportional to how deep into the skid we are (1 -> 0 as it
        // ends). Sign alternates with which way the ball is turning so it
        // reads as a "lean into the slide" rather than a random wobble.
        const skidT = player.reversalTimer > 0 ? player.reversalTimer / player.reversalDuration : 0;
        const turnSign = player.prevTargetX !== 0 ? Math.sign(player.prevTargetX) : 1;
        const targetRoll = skidT * SKID_CAMERA_ROLL * turnSign;
        this.skidRoll += (targetRoll - this.skidRoll) * SKID_CAMERA_ROLL_SMOOTH;
        this.camera.rotation.z += this.skidRoll;
    }
}