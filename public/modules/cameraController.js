import * as THREE from "three";
import { CAMERA_OFFSET, SKID_CAMERA_ROLL, SKID_CAMERA_ROLL_SMOOTH } from "./config.js";

export class CameraController {
    constructor(camera) {
        this.camera = camera;
        this.offset = new THREE.Vector3(CAMERA_OFFSET.x, CAMERA_OFFSET.y, CAMERA_OFFSET.z);
        this.target = new THREE.Vector3();
        // Smoothed separately from the raw skid intensity so it eases out.
        this.skidRoll = 0;
    }

    // `player` is the PlayerController — its reversalTimer/reversalDuration
    // and prevTargetX drive the skid-lean feedback.
    update(ballMesh, player) {
        this.target.copy(ballMesh.position);
        const desired = this.target.clone().add(this.offset);
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
