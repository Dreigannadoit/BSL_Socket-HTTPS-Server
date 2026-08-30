import * as THREE from "three";
import {
    RESPAWN_ANCHOR_DELAY,
    FALL_MARGIN,
    FADE_TRIGGER_MARGIN,
    FADE_OUT_DURATION,
    FADE_IN_DURATION,
} from "./config.js";

// Handles three related concerns:
//  - lastSafePosition: where the ball respawns, tracked with a short delay
//    behind the ball's live grounded position so a fast run off a ledge
//    lands you further back than a slow creep off the same edge.
//  - fall detection: once the ball drops below fallThresholdY (derived from
//    the level's own collision geometry), it gets teleported back.
//  - the fade-to-black overlay that starts before the ball actually reaches
//    the fall threshold, so the respawn itself happens off-screen.
export class RespawnSystem {
    constructor(ballBody, fadeOverlayEl, audioManager) {
        this.ballBody = ballBody;
        this.fadeOverlayEl = fadeOverlayEl;
        this.audioManager = audioManager;

        this.lastSafePosition = new THREE.Vector3();
        this.groundedHistory = []; // { t, x, y, z } samples while grounded, oldest first

        this.fallThresholdY = -Infinity; // set once level geometry loads
        this.fadeTriggerY = -Infinity;

        this.fadeState = "idle"; // "idle" | "fading-out" | "black" | "fading-in"
        this.fadeOpacity = 0;
    }

    // Derives the "fell off the world" threshold from the level's own
    // collision geometry instead of a hardcoded number, so it still works
    // if the map changes size/scale later. Anything this far below the
    // lowest collision mesh definitely isn't on the map anymore.
    setLevelBounds(collisionRoot, spawnPos) {
        if (collisionRoot) {
            const bounds = new THREE.Box3().setFromObject(collisionRoot);
            this.fallThresholdY = bounds.min.y - FALL_MARGIN;
        } else {
            this.fallThresholdY = spawnPos.y - FALL_MARGIN;
        }
        this.fadeTriggerY = this.fallThresholdY + FADE_TRIGGER_MARGIN;

        this.lastSafePosition.copy(spawnPos);
        this.resetGroundedHistory(spawnPos);
    }

    // (Re)seeds the history buffer with a single sample at the given
    // position, used both on initial spawn and after every respawn so
    // stale pre-fall samples never leak into the next fall's anchor
    // calculation.
    resetGroundedHistory(position) {
        this.groundedHistory.length = 0;
        this.groundedHistory.push({
            t: performance.now() / 1000,
            x: position.x,
            y: position.y,
            z: position.z,
        });
    }

    updateAnchor(isGrounded) {
        if (!isGrounded) return;

        const now = performance.now() / 1000;
        this.groundedHistory.push({
            t: now,
            x: this.ballBody.position.x,
            y: this.ballBody.position.y,
            z: this.ballBody.position.z,
        });

        // Trim from the front, but only while the SECOND-oldest sample is
        // still old enough to serve as the delayed anchor — that way
        // groundedHistory[0] always converges on "the freshest sample
        // that's still >= DELAY seconds old" instead of drifting all the
        // way up to the live position.
        const target = now - RESPAWN_ANCHOR_DELAY;
        while (this.groundedHistory.length > 1 && this.groundedHistory[1].t <= target) {
            this.groundedHistory.shift();
        }

        const anchor = this.groundedHistory[0];
        this.lastSafePosition.set(anchor.x, anchor.y, anchor.z);
    }

    checkRespawn(onRespawn) {
        if (this.ballBody.position.y < this.fallThresholdY) {
            this._respawnBall();
            if (onRespawn) onRespawn();
        }
    }

    _respawnBall() {
        const ballBody = this.ballBody;
        // Small +0.3 lift, same as the initial spawn placement, so the ball
        // doesn't spawn embedded in the floor it was standing on.
        ballBody.position.set(
            this.lastSafePosition.x,
            this.lastSafePosition.y + 0.3,
            this.lastSafePosition.z
        );
        ballBody.velocity.set(0, 0, 0);
        ballBody.angularVelocity.set(0, 0, 0);
        this.resetGroundedHistory(this.lastSafePosition);
        this.audioManager.playHotspotSound(0.6); // reuse as a respawn cue

        // The fade-to-black should already be finished by the time we get
        // here (it started FADE_TRIGGER_MARGIN meters higher up) — snap to
        // fully black as a safety net in case the fall was too short/fast
        // for that, then begin fading back into the main scene at the new
        // position.
        this.fadeOpacity = 1;
        this.fadeState = "fading-in";
    }

    updateFade(dt) {
        switch (this.fadeState) {
            case "idle":
                // Crossing the upper trigger (falling past it) kicks off
                // the fade.
                if (this.ballBody.position.y < this.fadeTriggerY) {
                    this.fadeState = "fading-out";
                }
                break;
            case "fading-out":
                this.fadeOpacity = Math.min(1, this.fadeOpacity + dt / FADE_OUT_DURATION);
                if (this.fadeOpacity >= 1) {
                    this.fadeOpacity = 1;
                    this.fadeState = "black"; // hold until _respawnBall() fires
                }
                break;
            case "black":
                break;
            case "fading-in":
                this.fadeOpacity = Math.max(0, this.fadeOpacity - dt / FADE_IN_DURATION);
                if (this.fadeOpacity <= 0) {
                    this.fadeOpacity = 0;
                    this.fadeState = "idle";
                }
                break;
        }
        this.fadeOverlayEl.style.opacity = this.fadeOpacity;
    }
}
