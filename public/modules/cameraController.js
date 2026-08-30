import * as THREE from "three";
import {
    CAMERA_OFFSET,
    HOTSPOT_CAMERA_OFFSET,
    HOTSPOT_CAMERA_FOV,
    HOTSPOT_TARGET_Y_OFFSET,
    HOTSPOT_CAMERA_BLEND,
    SKID_CAMERA_ROLL,
    SKID_CAMERA_ROLL_SMOOTH,
} from "./config.js";

export class CameraController {
    constructor(camera) {
        this.camera = camera;
        this.offset = new THREE.Vector3(CAMERA_OFFSET.x, CAMERA_OFFSET.y, CAMERA_OFFSET.z);
        this.hotspotOffset = new THREE.Vector3(
            HOTSPOT_CAMERA_OFFSET.x,
            HOTSPOT_CAMERA_OFFSET.y,
            HOTSPOT_CAMERA_OFFSET.z
        );
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
    }

    // `player` is the PlayerController — its reversalTimer/reversalDuration
    // and prevTargetX drive the skid-lean feedback. `isHotspotActive` comes
    // from HotspotSystem: while true, the camera eases into a tighter,
    // wider-FOV framing looking above the ball instead of straight at it.
    update(ballMesh, player, isHotspotActive = false) {
        const targetOffset = isHotspotActive ? this.hotspotOffset : this.offset;
        this.currentOffset.lerp(targetOffset, HOTSPOT_CAMERA_BLEND);

        const targetFov = isHotspotActive ? HOTSPOT_CAMERA_FOV : this.baseFov;
        this.currentFov += (targetFov - this.currentFov) * HOTSPOT_CAMERA_BLEND;
        if (Math.abs(this.camera.fov - this.currentFov) > 0.01) {
            this.camera.fov = this.currentFov;
            this.camera.updateProjectionMatrix();
        }

        const targetYOffset = isHotspotActive ? HOTSPOT_TARGET_Y_OFFSET : 0;
        this.currentTargetYOffset += (targetYOffset - this.currentTargetYOffset) * HOTSPOT_CAMERA_BLEND;

        this.target.copy(ballMesh.position);
        this.target.y += this.currentTargetYOffset;

        const desired = this.target.clone().add(this.currentOffset);
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