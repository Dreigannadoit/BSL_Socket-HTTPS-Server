import { createEntranceBeamVisuals, easeOutCubic, easeInCubic } from "./playerEntrance.js";
import {
    ENTRANCE_BEAM_HEIGHT,
    ENTRANCE_DESCEND_DURATION,
    ENTRANCE_HOLD_DURATION,
    ENTRANCE_RETRACT_DURATION,
    ENTRANCE_RING_DURATION,
    ENTRANCE_RING_MAX_SCALE,
} from "./config.js";

// The exact reverse of PlayerEntrance's spawn-beam sequence, played when the
// player confirms a RouteBasedTriggers marker (see RouteTriggerSystem/
// main.js) instead of at level load. Same beam visuals (built via the
// shared createEntranceBeamVisuals helper), same phase order and durations —
// only the moment the ball's visibility flips is reversed: PlayerEntrance
// reveals the ball the instant the beam finishes descending; PlayerExit
// hides it at that exact same instant instead, so the beam reads as
// "swallowing" the player rather than depositing them. The beam then
// retracts and disappears exactly as it does on entrance, and once it's
// fully gone, `onComplete` fires (main.js uses this to actually navigate
// the page) — the player is deliberately left frozen/hidden rather than
// restored, since the page is about to unload anyway.
export class PlayerExit {
    constructor(scene) {
        this.scene = scene;
        this.state = "idle"; // idle -> descend -> hold -> retract -> done
        this.elapsed = 0;
        this.ballMesh = null;
        this.player = null;
        this.onComplete = null;

        const { beamPivot, coreMesh, shellMesh, ring } = createEntranceBeamVisuals(scene);
        this.beamPivot = beamPivot;
        this.coreMesh = coreMesh;
        this.shellMesh = shellMesh;
        this.ring = ring;
        this.ringActive = false;
        this.ringElapsed = 0;
    }

    // Starts the reverse sequence at `worldPosition` (the ball's own live
    // position at the moment the trigger was confirmed — main.js passes
    // ballMesh.position). Freezes the player immediately (same as
    // PlayerEntrance.hidePlayer locking input before its own beam appears),
    // so movement stops the instant the exit begins rather than only once
    // the beam finishes dropping. `onComplete` fires once the beam has
    // fully retracted and vanished.
    play(ballMesh, player, worldPosition, onComplete) {
        this.ballMesh = ballMesh;
        this.player = player;
        this.onComplete = onComplete;
        this.targetPosition = worldPosition.clone();

        player.setFrozen(true);

        this.beamPivot.position.set(
            this.targetPosition.x,
            this.targetPosition.y + ENTRANCE_BEAM_HEIGHT,
            this.targetPosition.z
        );
        this.beamPivot.scale.set(1, 0.0001, 1);
        this.beamPivot.visible = true;

        this.ring.position.set(this.targetPosition.x, this.targetPosition.y + 0.03, this.targetPosition.z);
        this.ring.visible = false;
        this.ringActive = false;

        this.state = "descend";
        this.elapsed = 0;
    }

    _onBeamReachedTarget() {
        // Reverse of PlayerEntrance._onBeamReachedFloor: hides the ball
        // instead of revealing it, right as the ground-flash ring pops —
        // the beam visually "erases" the player at this instant.
        if (this.ballMesh) this.ballMesh.visible = false;
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
        // Deliberately NOT calling player.setFrozen(false) — unlike
        // PlayerEntrance, this sequence ends with the page navigating away
        // (see onComplete below), not with control handed back.
        if (this.onComplete) this.onComplete();
    }

    // Called every frame from the main loop. No-op once idle/done, so it's
    // always safe to call unconditionally alongside PlayerEntrance's own
    // update().
    update(dt, elapsedTime) {
        if (this.ringActive) this._updateRing(dt);

        if (this.state === "idle" || this.state === "done") return;

        this.elapsed += dt;

        // Same gentle flicker as PlayerEntrance so the beam doesn't read as
        // a flat, static shape while held open.
        const flicker = 0.9 + Math.sin(elapsedTime * 40) * 0.05;
        this.coreMesh.material.opacity = 0.9 * flicker;

        switch (this.state) {
            case "descend": {
                const t = Math.min(this.elapsed / ENTRANCE_DESCEND_DURATION, 1);
                this.beamPivot.scale.y = Math.max(easeOutCubic(t), 0.0001);
                if (t >= 1) {
                    this._onBeamReachedTarget();
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
