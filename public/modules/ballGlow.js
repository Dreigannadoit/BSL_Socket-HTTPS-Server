import * as THREE from "three";
import {
    BLOOM_LAYER,
    GLOW_COLOR,
    BALL_GLOW_INNER_MAX,
    BALL_GLOW_LIGHT_MAX,
    getAccelFraction,
} from "./config.js";

// Speed-linked glow for the ball's "inner_ball" / "ball_light" surfaces.
//
// These are NOT separate nodes in ball.glb — they're two of the four
// MATERIALS assigned to primitives on a single mesh node
// ("new_ball_2_colors": primitives use materials "ball", "ball2",
// "inner_ball", "ball_light"). GLTFLoader turns each differently-materialed
// primitive into its own child Mesh, so the reliable way to find the ones
// we want is by each mesh's material.name (carried over from the glTF
// material's own name) rather than by node name.
export class BallGlow {
    constructor() {
        this.innerMat = null;
        this.lightMat = null;
    }

    // Call once after the ball model has loaded.
    setup(root) {
        root.traverse((child) => {
            if (!child.isMesh || !child.material) return;

            const materialName = child.material.name;
            if (materialName === "inner_ball") {
                this.innerMat = this._replaceWithGlow(child, BALL_GLOW_INNER_MAX);
            } else if (materialName === "ball_light") {
                this.lightMat = this._replaceWithGlow(child, BALL_GLOW_LIGHT_MAX);
            }
        });

        if (!this.innerMat) {
            console.warn('BallGlow: no primitive using material "inner_ball" found.');
        }
        if (!this.lightMat) {
            console.warn('BallGlow: no primitive using material "ball_light" found.');
        }
    }

    // Swaps the given primitive's original (imported) material for an
    // emissive one we control, and enables BLOOM_LAYER on it so
    // BloomRenderer's isolated pass picks it up.
    _replaceWithGlow(mesh, maxIntensity) {
        const mat = new THREE.MeshStandardMaterial({
            color: GLOW_COLOR,
            emissive: GLOW_COLOR,
            emissiveIntensity: 0, // set for real in update()
            roughness: 0.3,
            metalness: 0,
            toneMapped: false, // let emissive push past 1.0 so bloom actually picks it up
        });
        mat.userData.maxIntensity = maxIntensity;
        mesh.material = mat;
        mesh.layers.enable(BLOOM_LAYER);
        return mat;
    }

    // holdMs: PlayerController's inputHoldTime, in milliseconds — the same
    // value getAccelFraction() uses for the movement ramp. Pass it in every
    // frame from the main loop. Reusing PlayerController's own timer here
    // (rather than keeping a second one) guarantees the glow ramps in
    // lockstep with acceleration: 50% bloom exactly when the ball hits the
    // speedFraction "50%" point, 70% at the "70%" point, full at 1100ms,
    // and back to 0 the instant input stops (inputHoldTime resets to 0 in
    // PlayerController._applyNoInput).
    update(holdMs) {
        const fraction = getAccelFraction(holdMs);
        if (this.innerMat) {
            this.innerMat.emissiveIntensity = fraction * this.innerMat.userData.maxIntensity;
        }
        if (this.lightMat) {
            this.lightMat.emissiveIntensity = fraction * this.lightMat.userData.maxIntensity;
        }
    }
}