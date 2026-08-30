import * as THREE from "three";
import * as CANNON from "cannon-es";
import {
    MAX_SPEED,
    DECEL_RATE,
    TURN_SMOOTHING,
    SLIDE_MIN_SLOPE,
    SLIDE_MAX_SPEED,
    REVERSAL_SKID_DURATION,
    REVERSAL_DOT_THRESHOLD,
    REVERSAL_MIN_SPEED,
    BOUNCE_DURATION,
    MAX_LANDING_BOUNCES,
    GROUND_RAY_LENGTH,
    MIN_AIRBORNE_TIME,
    getAccelFraction,
} from "./config.js";

// Owns ground detection, rolling/skidding movement, and the wall/landing
// bounce overlays. Exposes the state (isGrounded, reversalTimer, ...) that
// CameraController needs to lean into skids.
export class PlayerController {
    constructor(ballBody, world, keys, audioManager) {
        this.ballBody = ballBody;
        this.world = world;
        this.keys = keys;
        this.audioManager = audioManager;

        // Ground detection state
        this.groundNormal = new CANNON.Vec3(0, 1, 0);
        this.isGrounded = false;
        // Seconds since the ball was last confirmed grounded — a real fall
        // accumulates real time here; a seam/ramp raycast flicker lasts at
        // most one frame's dt.
        this.ungroundedTime = 0;

        // Landing bounce sequence: while active, applyRollInput leaves
        // velocity.y alone instead of locking it to the movement target, so
        // floorContact's restitution can produce a natural bounce instead
        // of being overwritten every frame. Capped at MAX_LANDING_BOUNCES
        // departures from the ground for a consistent "bounces a few times
        // then settles" feel instead of an uncontrolled bounce chain.
        this.landingBounceActive = false;
        this.bouncesRemaining = MAX_LANDING_BOUNCES;

        // Wall bounce overlay: smooth blending after wall impact
        this.wallHitPending = false; // set on collision, processed next frame
        this.bounceVelocity = new CANNON.Vec3();
        this.bounceTimer = 0;

        // Reversal skid state
        this.reversalTimer = 0;
        this.reversalVelocity = new CANNON.Vec3();
        this.reversalDuration = REVERSAL_SKID_DURATION; // for CameraController's ratio calc
        this.prevTargetX = 0;
        this.prevTargetZ = 0;

        // Smoothed input / accel-curve timing
        this.currentInput = { x: 0, z: 0 };
        this.inputHoldTime = 0;

        // Only ONE "collide" listener is needed. Wall impacts are the one
        // case the physics "collide" event is a reliable signal for (a wall
        // hit's velocity along the normal doesn't get resolved away by
        // CCD/substeps the way a floor landing's can), so that stays
        // event-driven here. Floor landings are detected via our own
        // raycast in checkGround() instead — see the comment there.
        ballBody.addEventListener("collide", (event) => this._onCollide(event));
    }

    _onCollide(event) {
        const normal = event.contact.ni;
        if (Math.abs(normal.y) < 0.7) {
            this.wallHitPending = true;
            this.audioManager.playBounceSound();
        }
    }

    checkGround(dt) {
        const from = this.ballBody.position;
        const to = new CANNON.Vec3(from.x, from.y - GROUND_RAY_LENGTH, from.z);

        const result = new CANNON.RaycastResult();
        this.world.raycastClosest(from, to, {
            skipBackfaces: true,
            collisionFilterMask: -1,
        }, result);

        const wasGrounded = this.isGrounded;

        if (result.hasHit) {
            this.isGrounded = true;
            this.groundNormal.copy(result.hitNormalWorld);
        } else {
            this.isGrounded = false;
            this.groundNormal.set(0, 1, 0);
        }

        // Landing detection lives here, not in the physics "collide" event.
        // Cannon's collide event fires at a point in the physics
        // substep/CCD resolution where the reported impact velocity isn't a
        // reliable signal — it can read near-zero for a genuine fall
        // depending on exact timing, which would silence real landings
        // along with seam glitches. Our own raycast state is unambiguous:
        // airborne one frame, grounded the next. Requiring
        // MIN_AIRBORNE_TIME of accumulated airtime before that transition
        // is what tells a real fall (the only way to be airborne at all,
        // since the player can't jump) apart from a one-frame seam/ramp
        // raycast flicker.
        if (this.isGrounded) {
            if (!wasGrounded) {
                if (this.ungroundedTime >= MIN_AIRBORNE_TIME && !this.landingBounceActive) {
                    this.landingBounceActive = true;
                    this.bouncesRemaining = MAX_LANDING_BOUNCES;
                    this.audioManager.playBounceSound(0.8);
                } else if (this.landingBounceActive) {
                    if (this.bouncesRemaining > 0) {
                        // Every bounce in the sequence gets its own sound,
                        // not just the first impact.
                        this.audioManager.playBounceSound(0.8);
                    } else {
                        // Used up every allotted bounce — end the sequence
                        // so the vertical-velocity lock can resume and the
                        // ball settles. Reset for the next real fall.
                        this.landingBounceActive = false;
                        this.bouncesRemaining = MAX_LANDING_BOUNCES;
                    }
                }
            }
            this.ungroundedTime = 0;
        } else {
            if (wasGrounded && this.landingBounceActive) {
                // Just left the ground again mid-sequence — restitution
                // bounced it back up, which uses one of its allotted
                // bounces.
                this.bouncesRemaining--;
            }
            this.ungroundedTime += dt;
        }
    }

    update(dt) {
        this.checkGround(dt);

        const ballBody = this.ballBody;
        const keys = this.keys;

        if (this.wallHitPending) {
            this.bounceVelocity.copy(ballBody.velocity);
            this.bounceTimer = BOUNCE_DURATION;
            // A wall hit should own the velocity blend outright — an
            // in-progress skid was blending toward a pre-impact direction,
            // and letting both run at once meant the two blends fought
            // over ballBody.velocity every frame, producing jittery/buggy
            // movement off walls.
            this.reversalTimer = 0;
            this.wallHitPending = false;
        }

        const rawX = (keys.right ? 1 : 0) + (keys.left ? -1 : 0);
        const rawZ = (keys.forward ? -1 : 0) + (keys.back ? 1 : 0);
        // Normalize to unit length so diagonal input (magnitude √2 with
        // both keys held) doesn't scale inputMag/moveDir past what a
        // single-axis key press produces — without this, diagonal movement
        // was ~41% faster than straight movement at the same MAX_SPEED.
        const rawMag = Math.hypot(rawX, rawZ);
        const targetX = rawMag > 0 ? rawX / rawMag : 0;
        const targetZ = rawMag > 0 ? rawZ / rawMag : 0;
        const noInput = targetX === 0 && targetZ === 0;

        if (noInput) {
            this._applyNoInput(dt);
            return;
        }

        this._applyInput(dt, targetX, targetZ);
    }

    _applyNoInput(dt) {
        const ballBody = this.ballBody;

        this.currentInput.x = 0;
        this.currentInput.z = 0;
        this.inputHoldTime = 0;
        // Clear so releasing then re-pressing the same direction later
        // isn't mistaken for a reversal.
        this.prevTargetX = 0;
        this.prevTargetZ = 0;
        this.reversalTimer = 0; // cancel any in-progress skid once input is let go

        const slopeAngle = Math.acos(THREE.MathUtils.clamp(this.groundNormal.y, -1, 1));

        if (this.isGrounded && slopeAngle > SLIDE_MIN_SLOPE) {
            const gravityMag = Math.abs(this.world.gravity.y);
            const gravityVec = new CANNON.Vec3(0, -gravityMag, 0);
            const gDot = gravityVec.dot(this.groundNormal);
            const downhillAccel = new CANNON.Vec3(
                gravityVec.x - this.groundNormal.x * gDot,
                gravityVec.y - this.groundNormal.y * gDot,
                gravityVec.z - this.groundNormal.z * gDot
            );

            ballBody.velocity.x += downhillAccel.x * dt;
            ballBody.velocity.z += downhillAccel.z * dt;

            const horizSpeed = Math.hypot(ballBody.velocity.x, ballBody.velocity.z);
            if (horizSpeed > SLIDE_MAX_SPEED) {
                const scale = SLIDE_MAX_SPEED / horizSpeed;
                ballBody.velocity.x *= scale;
                ballBody.velocity.z *= scale;
            }
            return;
        }

        const decelEase = 1 - Math.exp(-DECEL_RATE * dt);
        ballBody.velocity.x -= ballBody.velocity.x * decelEase;
        ballBody.velocity.z -= ballBody.velocity.z * decelEase;
    }

    _applyInput(dt, targetX, targetZ) {
        const ballBody = this.ballBody;

        // Reversal detection — compare the new input direction against the
        // ball's ACTUAL CURRENT VELOCITY direction (not last frame's raw
        // key state). This is robust to any keyup/keydown gap frames in
        // between, since it only cares about physical momentum vs. the new
        // command.
        if (this.reversalTimer <= 0) {
            const currentSpeed = Math.hypot(ballBody.velocity.x, ballBody.velocity.z);

            if (currentSpeed > REVERSAL_MIN_SPEED) {
                const velDirX = ballBody.velocity.x / currentSpeed;
                const velDirZ = ballBody.velocity.z / currentSpeed;

                const tMag = Math.hypot(targetX, targetZ);
                const inDirX = targetX / tMag;
                const inDirZ = targetZ / tMag;

                const dot = velDirX * inDirX + velDirZ * inDirZ;

                if (dot < REVERSAL_DOT_THRESHOLD) {
                    this.reversalVelocity.set(ballBody.velocity.x, 0, ballBody.velocity.z);
                    this.reversalTimer = REVERSAL_SKID_DURATION;
                    this.inputHoldTime = 0; // restart the 0/500/700/900ms accel curve from zero
                }
            }
        }

        // --- Input is active ---
        this.inputHoldTime += dt * 1000;

        const inputEase = 1 - Math.exp(-TURN_SMOOTHING * dt);
        this.currentInput.x += (targetX - this.currentInput.x) * inputEase;
        this.currentInput.z += (targetZ - this.currentInput.z) * inputEase;

        let moveDir = new CANNON.Vec3(this.currentInput.x, 0, this.currentInput.z);
        const dot = moveDir.dot(this.groundNormal);
        moveDir = new CANNON.Vec3(
            moveDir.x - this.groundNormal.x * dot,
            moveDir.y - this.groundNormal.y * dot,
            moveDir.z - this.groundNormal.z * dot
        );

        const inputMag = Math.hypot(this.currentInput.x, this.currentInput.z);
        if (moveDir.length() > 0.0001 && inputMag > 0.0001) {
            moveDir.normalize();
            moveDir.scale(inputMag, moveDir);
        }

        const slopeAngle = Math.acos(THREE.MathUtils.clamp(this.groundNormal.y, -1, 1));
        const upSlopeBoost = 1 + slopeAngle * 0.6;

        const speedFraction = getAccelFraction(this.inputHoldTime);

        let targetVelX = moveDir.x * MAX_SPEED * upSlopeBoost * speedFraction;
        let targetVelZ = moveDir.z * MAX_SPEED * upSlopeBoost * speedFraction;
        let targetVelY = moveDir.y * MAX_SPEED * upSlopeBoost * speedFraction;

        if (this.bounceTimer > 0) {
            this.bounceTimer -= dt;
            const t = 1 - Math.max(this.bounceTimer / BOUNCE_DURATION, 0);
            const blend = t * t * (3 - 2 * t);
            targetVelX = this.bounceVelocity.x * (1 - blend) + targetVelX * blend;
            targetVelZ = this.bounceVelocity.z * (1 - blend) + targetVelZ * blend;
        }

        // Reversal skid blend — slides from the captured old-direction
        // velocity toward the (now-restarting) new-direction target over
        // REVERSAL_SKID_DURATION. Early on this favors the old momentum, so
        // the ball keeps drifting the original way briefly; as it fades
        // toward the new target (which itself is ramping up from 0 via
        // speedFraction), the ball settles into accelerating the new
        // direction.
        if (this.reversalTimer > 0) {
            this.reversalTimer -= dt;
            const rt = 1 - Math.max(this.reversalTimer / REVERSAL_SKID_DURATION, 0);
            const rBlend = rt * rt * (3 - 2 * rt);
            targetVelX = this.reversalVelocity.x * (1 - rBlend) + targetVelX * rBlend;
            targetVelZ = this.reversalVelocity.z * (1 - rBlend) + targetVelZ * rBlend;
        }

        ballBody.velocity.x = targetVelX;
        ballBody.velocity.z = targetVelZ;

        if (this.isGrounded && this.bounceTimer <= 0 && !this.landingBounceActive) {
            ballBody.velocity.y = targetVelY;
        }

        // Remember this frame's input direction for next frame's reversal
        // check and for CameraController's skid-lean sign.
        this.prevTargetX = targetX;
        this.prevTargetZ = targetZ;
    }
}
