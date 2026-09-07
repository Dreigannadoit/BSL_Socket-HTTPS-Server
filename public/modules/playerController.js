import * as THREE from "three";
import * as CANNON from "cannon-es";
import {
    MAX_SPEED,
    DECEL_RATE,
    TURN_SMOOTHING,
    AIR_CONTROL_RATE,
    BALL_RADIUS,
    MOVABLE_PROP_CLIMB_TOLERANCE,
    SLIDE_MIN_SLOPE,
    REVERSAL_SKID_DURATION,
    REVERSAL_DOT_THRESHOLD,
    REVERSAL_MIN_SPEED,
    BOUNCE_DURATION,
    MAX_LANDING_BOUNCES,
    GROUND_RAY_LENGTH,
    MIN_AIRBORNE_TIME,
    HOTSPOT_WOBBLE_AMPLITUDE,
    HOTSPOT_WOBBLE_FREQUENCY,
    HOTSPOT_WOBBLE_DECAY,
    MOVABLE_COLLISION_GROUP,
    getAccelFraction,
    getStartHoldMs,
} from "./config.js";
// Mask for the ground-detection raycast in checkGround(): everything
// (-1) except the movable-prop collision group — see
// MOVABLE_COLLISION_GROUP's comment in config.js for why that ray needs to
// ignore props specifically (otherwise the ball reads standing next to one
// as standing on a ramp, and climbs it instead of pushing it).
const GROUND_RAY_MASK = -1 & ~MOVABLE_COLLISION_GROUP;

// Owns ground detection, rolling/skidding movement, and the wall/landing
// bounce overlays. Exposes the state (isGrounded, reversalTimer, ...) that
// CameraController needs to lean into skids.
export class PlayerController {
    constructor(ballBody, world, keys, audioManager) {
        this.ballBody = ballBody;
        this.world = world;
        this.keys = keys;
        this.audioManager = audioManager;

        // Current mode's speed cap — defaults to Free Roam's MAX_SPEED and
        // is overridden by GameModeManager.selectMode() via setMaxSpeed()
        // when Speedrun/Time Trial (or Free Roam again) is chosen. Also
        // doubles as the slope-sliding speed cap (previously the separate
        // SLIDE_MAX_SPEED constant, which was always just an alias for
        // MAX_SPEED).
        this.maxSpeed = MAX_SPEED;

        // Ground detection state
        this.groundNormal = new CANNON.Vec3(0, 1, 0);
        this.isGrounded = false;
        this.groundHitY = null;
        // See update()'s comment — true whenever isGrounded is true OR the
        // ball is touching a movable prop; drives _applyInput's movement
        // branch so pushing stays fully responsive.
        this.effectiveGrounded = false;
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

        // Set by _onCollide whenever the ball contacts a movable prop this
        // physics step, consumed (and cleared) at the top of the NEXT
        // update() — see its use in update() for why this stops the ball
        // from being launched up and over a prop it's pushing.
        this.touchingMovableProp = false;

        // Reversal skid state
        this.reversalTimer = 0;
        this.reversalVelocity = new CANNON.Vec3();
        this.reversalDuration = REVERSAL_SKID_DURATION; // for CameraController's ratio calc
        this.prevTargetX = 0;
        this.prevTargetZ = 0;

        // Smoothed input / accel-curve timing
        this.currentInput = { x: 0, z: 0 };
        this.inputHoldTime = 0;
        // True while input has been continuously held since the last
        // release. Drives the "fresh press" check in _applyInput that
        // seeds inputHoldTime from current speed instead of 0.
        this.wasInputActive = false;

        // Whether the ball is currently inside an active hotspot trigger
        // (HotspotSystem.isActive). Independent of stuckTimer — stuckTimer
        // only covers the brief lockout right after entry, while this
        // stays true for as long as the ball remains in range, including
        // after control returns. Used to mute movement feel (half speed,
        // no wall/landing bounce feedback) for the whole time the ball is
        // near the marker, not just during the initial freeze.
        this.isHotspotActive = false;

        // Hotspot stun: while > 0, movement is fully frozen — momentum is
        // canceled the moment it starts (see stick()) and horizontal
        // velocity stays pinned at 0 every frame (see _applyStuck()).
        // Gravity/vertical velocity is untouched, so a stun starting
        // mid-air still falls and lands normally.
        this.stuckTimer = 0;

        // External hard-freeze switch — used by GameModeManager while a
        // mode-result popup (or the Free Roam "end run?" confirmation) is
        // on screen. Unlike stick(), this has no timer of its own and stays
        // frozen until setFrozen(false) is called explicitly.
        this.frozen = false;

        // Wobble-to-stop: while stuck, the ball oscillates sideways around
        // where it was when the lockout started, decaying to ~0 by the end
        // of the lockout. wobbleDir is perpendicular to the ball's travel
        // direction at that moment; wobbleCenter is its position then.
        this.wobbleTime = 0;
        this.wobbleDirX = 1;
        this.wobbleDirZ = 0;
        this.wobbleCenterX = 0;
        this.wobbleCenterZ = 0;

        // Only ONE "collide" listener is needed. Wall impacts are the one
        // case the physics "collide" event is a reliable signal for (a wall
        // hit's velocity along the normal doesn't get resolved away by
        // CCD/substeps the way a floor landing's can), so that stays
        // event-driven here. Floor landings are detected via our own
        // raycast in checkGround() instead — see the comment there.
        ballBody.addEventListener("collide", (event) => this._onCollide(event));
    }

    _onCollide(event) {
        // A movable prop is physically a similarly ball-sized sphere now
        // (see movableObjectSystem.js's MOVABLE_MIN_RADIUS_FACTOR), so a
        // push against one generates a contact normal that's just as
        // horizontal as an actual wall hit would be — without this check,
        // every push was misread as repeatedly slamming into a wall:
        // the bounce sound fired on every contact, and the wall-hit
        // velocity blend below (see wallHitPending's handling) actively
        // redirected/resisted the ball's velocity, fighting the push. The
        // real physics contact (and the resulting push) still happens
        // regardless — this only skips the extra game-feel layer on top,
        // which was never meant for anything but real level geometry.
        if (event.body.isMovableProp) {
            // A movable prop's collision sphere is only ever floored at
            // BALL_RADIUS, not fixed to it — packed-together props get
            // theirs shrunk smaller so they don't overlap their neighbors
            // (see MOVABLE_MIN_RADIUS_FACTOR/neighborSafeRadius in
            // movableObjectSystem.js). A shrunk prop then rests with its
            // sphere CENTER lower than the ball's (which always sits at
            // exactly BALL_RADIUS above the floor), so the sphere-vs-sphere
            // contact normal points up-and-out instead of level — pushing
            // the ball up onto the prop instead of just shoving it
            // sideways. Flagging the contact here and clamping the
            // resulting vertical velocity next frame (see update()) stops
            // that climb before it starts, without having to touch the
            // collider geometry itself.
            this.touchingMovableProp = true;
            return;
        }

        const normal = event.contact.ni;
        if (Math.abs(normal.y) < 0.7) {
            // No wall-bounce overlay while parked on a hotspot — the
            // physical restitution still nudges the ball (that's cannon-es
            // resolving the actual collision), but we don't layer the
            // smoothed bounce-blend feedback on top of it.
            if (this.isHotspotActive) return;
            this.wallHitPending = true;
            this.audioManager.playBounceSound();
        }
    }

    // Called every frame from the main loop with HotspotSystem.isActive.
    // Immediately cancels any bounce feedback already in flight so
    // stepping onto a hotspot mid-bounce doesn't let the sequence finish
    // out before going quiet.
    setHotspotActive(active) {
        this.isHotspotActive = active;
        if (active) {
            this.bounceTimer = 0;
            this.wallHitPending = false;
            this.landingBounceActive = false;
            this.bouncesRemaining = MAX_LANDING_BOUNCES;
        }
    }

    // Called by GameModeManager to hard-freeze/unfreeze movement while a
    // popup (mode result, Free Roam exit confirmation) is up. Zeroes
    // horizontal velocity and the input/skid state immediately on
    // freezing, same as _applyStuck, so nothing carries over once it's
    // released.
    setFrozen(active) {
        this.frozen = active;
        if (active) {
            this.ballBody.velocity.x = 0;
            this.ballBody.velocity.z = 0;
            this.currentInput.x = 0;
            this.currentInput.z = 0;
            this.inputHoldTime = 0;
            this.wasInputActive = false;
            this.reversalTimer = 0;
            this.prevTargetX = 0;
            this.prevTargetZ = 0;
        }
    }

    // Called by GameModeManager.selectMode() so each mode's top speed
    // (and slope-sliding cap, which just mirrors it) takes effect
    // immediately — no need to wait for a fresh press.
    setMaxSpeed(maxSpeed) {
        this.maxSpeed = maxSpeed;
    }

    // Locks out player input for `seconds` (e.g. when a hotspot fires).
    // Uses max() so a hotspot triggered mid-stun extends rather than
    // shortens the lockout. Only (re)anchors the wobble on a FRESH lockout
    // (stuckTimer was already at 0) so re-triggering mid-wobble extends the
    // timer without restarting the oscillation from a jarring new center.
    stick(seconds) {
        const wasStuck = this.stuckTimer > 0;
        this.stuckTimer = Math.max(this.stuckTimer, seconds);

        if (!wasStuck) {
            const ballBody = this.ballBody;
            const speed = Math.hypot(ballBody.velocity.x, ballBody.velocity.z);
            if (speed > 0.001) {
                // Perpendicular to the current travel direction (rotate
                // the horizontal velocity 90°), so the wobble reads as
                // "shaking off to the side" rather than jittering forward.
                this.wobbleDirX = -ballBody.velocity.z / speed;
                this.wobbleDirZ = ballBody.velocity.x / speed;
            } else {
                this.wobbleDirX = 1;
                this.wobbleDirZ = 0;
            }
            this.wobbleCenterX = ballBody.position.x;
            this.wobbleCenterZ = ballBody.position.z;
            this.wobbleTime = 0;

            // Cancel all horizontal momentum immediately, rather than
            // letting it decay — from here the wobble is a pure position
            // nudge, not leftover velocity that could still carry the ball
            // somewhere.
            ballBody.velocity.x = 0;
            ballBody.velocity.z = 0;
        }
    }

    // While stuck, movement is fully disabled rather than merely
    // decelerating: horizontal velocity is pinned to exactly 0 every
    // frame, not eased toward it, so there's no residual momentum left the
    // instant the lockout ends. Vertical velocity (gravity) is untouched,
    // so the ball still falls/lands normally if the stun starts mid-air.
    // The wobble is layered on top as a pure position nudge.
    _applyStuck(dt) {
        const ballBody = this.ballBody;
        ballBody.velocity.x = 0;
        ballBody.velocity.z = 0;

        this.currentInput.x = 0;
        this.currentInput.z = 0;
        this.inputHoldTime = 0;
        this.wasInputActive = false;
        this.prevTargetX = 0;
        this.prevTargetZ = 0;
        this.reversalTimer = 0;

        this._applyWobble(dt);
    }

    // Nudges the ball's position sideways around wobbleCenter by a
    // decaying sine offset — a pure visual shake, not a velocity change,
    // since _applyStuck() already pins horizontal velocity to 0 while this
    // is active.
    _applyWobble(dt) {
        this.wobbleTime += dt;
        const decay = Math.exp(-HOTSPOT_WOBBLE_DECAY * this.wobbleTime);
        const offset =
            Math.sin(this.wobbleTime * HOTSPOT_WOBBLE_FREQUENCY * Math.PI * 2) *
            HOTSPOT_WOBBLE_AMPLITUDE *
            decay;
        this.ballBody.position.x = this.wobbleCenterX + this.wobbleDirX * offset;
        this.ballBody.position.z = this.wobbleCenterZ + this.wobbleDirZ * offset;
    }

    checkGround(dt) {
        const from = this.ballBody.position;
        const to = new CANNON.Vec3(from.x, from.y - GROUND_RAY_LENGTH, from.z);

        const result = new CANNON.RaycastResult();
        this.world.raycastClosest(from, to, {
            skipBackfaces: true,
            collisionFilterMask: GROUND_RAY_MASK,
        }, result);

        const wasGrounded = this.isGrounded;

        if (result.hasHit) {
            this.isGrounded = true;
            this.groundNormal.copy(result.hitNormalWorld);
            // The TRUE floor height directly below the ball, ignoring
            // movable props (GROUND_RAY_MASK excludes them) — used by
            // update() to pin the ball's height while it's touching a prop.
            // Real floor/wall geometry only, so it's exactly the height the
            // ball should be resting at regardless of what a prop's own
            // (possibly shrunk, see movableObjectSystem.js) collision
            // sphere is trying to do to it.
            this.groundHitY = result.hitPointWorld.y;
        } else {
            this.isGrounded = false;
            this.groundNormal.set(0, 1, 0);
            this.groundHitY = null;
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
                if (this.isHotspotActive) {
                    // Land silently and settle — no bounce sequence while
                    // on a hotspot.
                    this.landingBounceActive = false;
                    this.bouncesRemaining = MAX_LANDING_BOUNCES;
                } else if (this.ungroundedTime >= MIN_AIRBORNE_TIME && !this.landingBounceActive) {
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

        // Consume last step's movable-prop contact flag (see _onCollide).
        // Two corrections, both needed:
        //  1. Kill any upward velocity picked up from the contact.
        //  2. Pin the ball's height back down to the TRUE floor (from this
        //     frame's checkGround raycast, which ignores props) if it's
        //     drifted above it. #1 alone isn't enough — cannon-es resolves
        //     interpenetration by nudging POSITION directly as well as
        //     velocity, so zeroing velocity.y after the fact doesn't undo a
        //     position nudge that already happened; left alone, a few
        //     millimeters of drift per contacting frame compounds into a
        //     slow climb up the prop instead of a launch off it — and once
        //     the ball's sitting on top, the contact normal is nearly
        //     vertical, so there's nothing left to actually push the prop
        //     sideways with. Pinning to the real floor height every frame
        //     the ball is in contact stops the drift before it can compound.
        const touchingProp = this.touchingMovableProp;
        this.touchingMovableProp = false;
        if (touchingProp) {
            if (ballBody.velocity.y > 0) ballBody.velocity.y = 0;
            if (this.groundHitY !== null) {
                const restHeight = this.groundHitY + BALL_RADIUS;
                if (ballBody.position.y > restHeight + MOVABLE_PROP_CLIMB_TOLERANCE) {
                    ballBody.position.y = restHeight;
                }
            }
        }
        // Movement control (see _applyInput) treats contact with a prop as
        // equivalent to being grounded. Without this, isGrounded's own
        // raycast flickers false on ordinary contact with a prop (not just
        // while climbing), which would otherwise fall through to
        // _applyInput's airborne-easing branch — that easing lets the
        // prop's physical push-back resistance bleed into the BALL's own
        // speed, which fights this game's actual design (see
        // MOVABLE_MASS's comment in config.js): the ball is meant to always
        // move at full commanded speed regardless of what it's pushing —
        // only the PROP is supposed to feel heavy/light, never the ball.
        // The clamp/reposition above already rules out an actual climb or
        // launch, so there's no downside to keeping push response at full
        // strength here.
        this.effectiveGrounded = this.isGrounded || touchingProp;

        if (this.frozen) {
            ballBody.velocity.x = 0;
            ballBody.velocity.z = 0;
            return;
        }

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

        // While stuck (e.g. right after a hotspot fires), movement is
        // fully frozen — not just steering locked out. See _applyStuck().
        if (this.stuckTimer > 0) {
            this.stuckTimer = Math.max(0, this.stuckTimer - dt);
            this._applyStuck(dt);
            return;
        }

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
        // NOTE: inputHoldTime is deliberately left alone here — it no
        // longer gets zeroed on release. The ball's velocity isn't zeroed
        // either (it just decays below), so resetting the accel curve to 0
        // while real velocity was still nonzero used to cause the next
        // _applyInput() to hard-set velocity back to ~0 on its very first
        // frame. Instead we just flag input as released; _applyInput()
        // reseeds inputHoldTime from the ball's actual current speed the
        // next time input resumes (see wasInputActive below).
        this.wasInputActive = false;
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
            if (horizSpeed > this.maxSpeed) {
                const scale = this.maxSpeed / horizSpeed;
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

        // Fresh press after a release (not a continuous hold) — seed the
        // accel curve from the ball's current speed instead of 0, so a
        // press mid-roll continues the ramp from wherever momentum already
        // is rather than snapping velocity down to ~0 first. Skips 0-0.50
        // of MAX_SPEED into phase 0, 0.51-0.70 into phase 1, 0.71-1.0 into
        // phase 2 (see getStartHoldMs in config.js).
        if (!this.wasInputActive) {
            const currentSpeed = Math.hypot(ballBody.velocity.x, ballBody.velocity.z);
            this.inputHoldTime = getStartHoldMs(currentSpeed / this.maxSpeed);
            // currentInput also gets zeroed on release (see _applyNoInput).
            // Seed it to the ball's CURRENT TRAVEL DIRECTION (not the
            // newly-pressed key's direction) so the TURN_SMOOTHING ease
            // below curves from old heading to new heading — the same
            // curving behavior that already happens when a second
            // direction key is added while the first is still held.
            // Snapping straight to the new target here (an earlier attempt)
            // fixed the magnitude but produced an instant snap-turn instead
            // of a curve when the new direction differs from the old one.
            if (currentSpeed > 0.0001) {
                this.currentInput.x = ballBody.velocity.x / currentSpeed;
                this.currentInput.z = ballBody.velocity.z / currentSpeed;
            } else {
                // Ball was already at rest — nothing to curve from.
                this.currentInput.x = targetX;
                this.currentInput.z = targetZ;
            }
            this.wasInputActive = true;
        }

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
        // Half speed while parked on a hotspot — same accel curve, just
        // scaled down, so it still ramps smoothly rather than feeling
        // capped.
        const hotspotSpeedScale = this.isHotspotActive ? 0.5 : 1;

        let targetVelX = moveDir.x * this.maxSpeed * upSlopeBoost * speedFraction * hotspotSpeedScale;
        let targetVelZ = moveDir.z * this.maxSpeed * upSlopeBoost * speedFraction * hotspotSpeedScale;
        let targetVelY = moveDir.y * this.maxSpeed * upSlopeBoost * speedFraction * hotspotSpeedScale;

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

        if (this.effectiveGrounded) {
            ballBody.velocity.x = targetVelX;
            ballBody.velocity.z = targetVelZ;
        } else {
            // While genuinely airborne (not just touching a movable prop —
            // see effectiveGrounded in update()), EASE toward the target
            // instead of snapping to it outright. Grounded movement can
            // hard-set velocity every frame because checkGround() catches
            // it again next frame either way — but if the ball is ever
            // truly lifted off everything (a real fall/launch), hard-
            // setting full speed here every frame would let held input
            // rocket it in that direction with nothing to check it. Easing
            // instead gives a little air control without that runaway.
            const airEase = 1 - Math.exp(-AIR_CONTROL_RATE * dt);
            ballBody.velocity.x += (targetVelX - ballBody.velocity.x) * airEase;
            ballBody.velocity.z += (targetVelZ - ballBody.velocity.z) * airEase;
        }

        if (this.effectiveGrounded && this.bounceTimer <= 0 && !this.landingBounceActive) {
            ballBody.velocity.y = targetVelY;
        }

        // Remember this frame's input direction for next frame's reversal
        // check and for CameraController's skid-lean sign.
        this.prevTargetX = targetX;
        this.prevTargetZ = targetZ;
    }
}