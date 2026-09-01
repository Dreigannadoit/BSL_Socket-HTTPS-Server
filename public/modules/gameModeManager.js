import * as THREE from "three";
import {
    BALL_RADIUS,
    BLOOM_LAYER,
    GAME_MODE_FREE_ROAM,
    GAME_MODE_SPEEDRUN,
    GAME_MODE_TIME_TRIAL,
    HOTSPOT_1_NAME,
    TIME_TRIAL_DURATION,
    TIME_TRIAL_ORB_COUNT,
    ORB_COLOR,
    ORB_MIN_RADIUS,
    TRIGGER_EXPAND,
} from "./config.js";
import { EndTriggerEffect } from "./endTriggerEffect.js";

const MODE_LABELS = {
    [GAME_MODE_FREE_ROAM]: "Free Roam",
    [GAME_MODE_SPEEDRUN]: "Speedrun",
    [GAME_MODE_TIME_TRIAL]: "Time Trial",
};

// Owns the three selectable game modes and everything that bookends a
// timed run:
//  - StartTrigger: a solid physics collider until a mode is picked (that's
//    what physically blocks the player from the course), then passable —
//    and, once passable, a trigger zone that starts the Speedrun timer /
//    Time Trial countdown the instant the ball first rolls through it.
//  - EndTrigger: a pure trigger zone (never solid) whose effect depends on
//    the active mode — a "restart?" confirmation in Free Roam, or the
//    finish line in Speedrun/Time Trial.
//  - Collectables: ~124 authored "Sphere" markers, of which Time Trial
//    randomly lights up 20 as real, pickup-able glowing orbs each run.
//
// Hotspot_1 doubles as the mode-select menu (see hotspotSystem.js's
// HOTSPOT_CONTENT) — selectMode()/getMode() are what that popup's buttons
// call into.
export class GameModeManager {
    constructor({ scene, world, addTrimeshCollider, ballBody, player, respawnSystem, hotspotSystem, audioManager, ui }) {
        this.scene = scene;
        this.world = world;
        this.addTrimeshCollider = addTrimeshCollider;
        this.ballBody = ballBody;
        this.player = player;
        this.respawnSystem = respawnSystem;
        this.hotspotSystem = hotspotSystem;
        this.audioManager = audioManager;
        this.ui = ui;

        this.mode = null; // null | "freeroam" | "speedrun" | "timetrial"
        this.runStarted = false; // has the ball touched StartTrigger yet, for the current mode

        this.startTriggerMesh = null;
        this.endTriggerMesh = null;
        this.startBounds = null; // THREE.Box3, world space, expanded by ball radius
        this.endBounds = null;
        this.startTriggerBody = null; // solid CANNON body — present in the world only while mode === null (or, in a timed mode, once the run has started — see _pendingStartLock)
        this.startTriggerBlocking = false;
        this.insideStart = false; // hysteresis so touching a trigger fires once, on the edge
        this.insideEnd = false;
        // Set once a timed-mode run starts (never in Free Roam): waits for
        // the ball to fully clear StartTrigger's bounds before re-adding
        // its solid collider, so the player can't roll back through the
        // start line mid-run. Deferred rather than done immediately in
        // _onStartTouched() to avoid re-solidifying a collider the ball is
        // still overlapping (which physics would resolve by shoving it).
        this._pendingStartLock = false;

        this.endEffect = new EndTriggerEffect();

        this.collectableCandidates = []; // { center: Vector3, radius } — all ~124, inventoried once
        this.activeOrbs = []; // { mesh, center, radius } — the 20 live picks for the current Time Trial run
        this.orbsCollected = 0;
        this._failing = false; // guards against _failTimeTrial firing more than once per run

        this.speedrunElapsed = 0;
        this.timeTrialRemaining = TIME_TRIAL_DURATION;

        this.ui.setMode(null);
    }

    // Called once from levelLoader right after the GLB has loaded and been
    // added to the scene. Wires up the two trigger volumes and inventories
    // every Collectables/Sphere_N child for later random selection.
    onLevelLoaded({ root }) {
        this.startTriggerMesh = root.getObjectByName("StartTrigger");
        this.endTriggerMesh = root.getObjectByName("EndTrigger");
        const collectablesRoot = root.getObjectByName("Collectables");

        if (this.startTriggerMesh) {
            this.startTriggerMesh.visible = false;
            this.startBounds = new THREE.Box3()
                .setFromObject(this.startTriggerMesh)
                .expandByScalar(BALL_RADIUS + TRIGGER_EXPAND);
            // Solid until a mode is picked — this is what physically blocks
            // the player from the course before choosing one.
            this.startTriggerBody = this.addTrimeshCollider(this.startTriggerMesh);
            this.startTriggerBlocking = true;
        } else {
            console.warn('GameModeManager: no "StartTrigger" node found — game modes are disabled.');
        }

        if (this.endTriggerMesh) {
            this.endBounds = new THREE.Box3()
                .setFromObject(this.endTriggerMesh)
                .expandByScalar(BALL_RADIUS + TRIGGER_EXPAND);
            // Glow core + pulsating rings + finish-column wall — see
            // endTriggerEffect.js. This also makes endTriggerMesh visible
            // (it used to stay hidden) and swaps in its glow material.
            this.endEffect.setup(this.endTriggerMesh, this.scene);
        } else {
            console.warn('GameModeManager: no "EndTrigger" node found — game modes are disabled.');
        }

        if (collectablesRoot) {
            collectablesRoot.traverse((child) => {
                if (child === collectablesRoot || !child.isMesh) return;
                child.visible = false; // markers only — never rendered directly

                const center = new THREE.Vector3();
                child.getWorldPosition(center);

                child.geometry.computeBoundingSphere();
                const scale = new THREE.Vector3();
                child.getWorldScale(scale);
                const avgScale = (scale.x + scale.y + scale.z) / 3;
                const radius = Math.max(child.geometry.boundingSphere.radius * avgScale, ORB_MIN_RADIUS);

                this.collectableCandidates.push({ center, radius });
            });
        } else {
            console.warn('GameModeManager: no "Collectables" node found — Time Trial will have no orbs.');
        }
    }

    getMode() {
        return this.mode;
    }

    // Called from Hotspot_1's mode-select menu.
    selectMode(mode) {
        if (!this.startTriggerMesh || !this.endTriggerMesh) return; // nothing to run without both triggers
        if (this.mode === mode) return;

        this._resetRunState();
        this.mode = mode;
        this.runStarted = false;
        this.ui.setMode(mode);
        this.ui.flashMessage(`${MODE_LABELS[mode]} selected — head to the Start marker!`);

        // StartTrigger becomes passable the moment a mode is chosen.
        if (this.startTriggerBlocking) {
            this.world.removeBody(this.startTriggerBody);
            this.startTriggerBlocking = false;
        }

        if (mode === GAME_MODE_FREE_ROAM) {
            this.hotspotSystem.restoreAll();
        } else {
            this.hotspotSystem.hideAllExcept(HOTSPOT_1_NAME);
        }
    }

    // Every frame from the main loop.
    update(dt, ballPosition, elapsed) {
        // EndTrigger's glow/rings/wall animate regardless of game mode —
        // it's a standing decorative fixture, not run-state.
        this.endEffect.update(elapsed);

        // Orbs keep a gentle breathing pulse regardless of anything else,
        // same style as GlowPath/HotspotSystem's glow.
        if (this.activeOrbs.length > 0) {
            const pulse = 2.4 + (0.5 + Math.sin(elapsed * 3) * 0.5) * 1.2;
            for (const orb of this.activeOrbs) orb.mesh.material.emissiveIntensity = pulse;
        }

        if (this.mode === null) return;

        this._checkStartTrigger(ballPosition);
        this._checkStartLockout(ballPosition);
        this._checkEndTrigger(ballPosition);

        if (this.mode === GAME_MODE_SPEEDRUN && this.runStarted) {
            this.speedrunElapsed += dt;
            this.ui.setTimer(this._formatTime(this.speedrunElapsed));
        }

        if (this.mode === GAME_MODE_TIME_TRIAL && this.runStarted) {
            this.timeTrialRemaining -= dt;
            this.ui.setTimer(this._formatTime(Math.max(0, this.timeTrialRemaining)));
            this._checkOrbPickups(ballPosition);

            if (this.timeTrialRemaining <= 0) {
                this._failTimeTrial();
            }
        }
    }

    _checkStartTrigger(ballPosition) {
        if (!this.startBounds || this.runStarted) return;
        const inside = this.startBounds.containsPoint(ballPosition);
        if (inside && !this.insideStart) {
            this._onStartTouched();
        }
        this.insideStart = inside;
    }

    // Re-solidifies StartTrigger once the ball has fully rolled clear of
    // it after a timed-mode run has begun (see _onStartTouched). No-op
    // once done, and never runs at all in Free Roam.
    _checkStartLockout(ballPosition) {
        if (!this._pendingStartLock || !this.startBounds || !this.startTriggerBody) return;
        const inside = this.startBounds.containsPoint(ballPosition);
        if (!inside) {
            this.world.addBody(this.startTriggerBody);
            this.startTriggerBlocking = true;
            this._pendingStartLock = false;
        }
    }

    _onStartTouched() {
        this.runStarted = true;
        this.audioManager.playHotspotSound(0.5);

        // In any timed mode (never Free Roam, where free movement in both
        // directions is the point), the player shouldn't be able to roll
        // back through the start line mid-run. Deferred to
        // _checkStartLockout() rather than done here — the ball is still
        // physically overlapping StartTrigger's bounds at this exact
        // instant, and re-adding a solid collider under it now would let
        // physics resolve that overlap by shoving the ball.
        if (this.mode !== GAME_MODE_FREE_ROAM) {
            this._pendingStartLock = true;
        }

        if (this.mode === GAME_MODE_SPEEDRUN) {
            this.speedrunElapsed = 0;
            this.ui.setTimer(this._formatTime(0));
            this.ui.flashMessage("GO! Race to the End marker!");
        } else if (this.mode === GAME_MODE_TIME_TRIAL) {
            this.timeTrialRemaining = TIME_TRIAL_DURATION;
            this.orbsCollected = 0;
            this._spawnOrbs();
            this.ui.setOrbCount(this.orbsCollected, TIME_TRIAL_ORB_COUNT);
            this.ui.setTimer(this._formatTime(this.timeTrialRemaining));
            this.ui.flashMessage(`GO! Collect all ${TIME_TRIAL_ORB_COUNT} orbs!`);
        }
    }

    _checkEndTrigger(ballPosition) {
        if (!this.endBounds) return;
        const inside = this.endBounds.containsPoint(ballPosition);
        if (inside && !this.insideEnd) {
            this._onEndTouched();
        }
        this.insideEnd = inside;
    }

    _onEndTouched() {
        if (this.mode === GAME_MODE_FREE_ROAM) {
            this._confirmFreeRoamExit();
            return;
        }

        if (!this.runStarted) return; // haven't crossed StartTrigger yet — EndTrigger is a no-op until then

        if (this.mode === GAME_MODE_SPEEDRUN) {
            this._completeSpeedrun();
        } else if (this.mode === GAME_MODE_TIME_TRIAL) {
            if (this.orbsCollected >= TIME_TRIAL_ORB_COUNT) {
                this._completeTimeTrial();
            } else {
                this.ui.flashMessage(`Collect all the orbs first! (${this.orbsCollected}/${TIME_TRIAL_ORB_COUNT})`);
            }
        }
    }

    _confirmFreeRoamExit() {
        this.player.setFrozen(true);
        this.ui.showPopup({
            title: "End Free Roam?",
            message: "Restart at Spawn and leave Free Roam mode?",
            buttons: [
                { label: "Yes", onClick: () => { this.ui.hidePopup(); this._exitToSpawn(); } },
                { label: "No", onClick: () => { this.ui.hidePopup(); this.player.setFrozen(false); } },
            ],
        });
    }

    _completeSpeedrun() {
        this.player.setFrozen(true);
        this.audioManager.playHotspotSound(0.6);
        const finalTime = this._formatTime(this.speedrunElapsed);
        this.ui.showPopup({
            title: "Speedrun Complete!",
            message: `Your time: ${finalTime}`,
            buttons: [{ label: "Continue", onClick: () => { this.ui.hidePopup(); this._exitToSpawn(); } }],
        });
    }

    _completeTimeTrial() {
        this.player.setFrozen(true);
        this.audioManager.playHotspotSound(0.6);
        const finalTime = this._formatTime(TIME_TRIAL_DURATION - Math.max(0, this.timeTrialRemaining));
        this.ui.showPopup({
            title: "Time Trial Complete!",
            message: `All ${TIME_TRIAL_ORB_COUNT} orbs collected in ${finalTime}`,
            buttons: [{ label: "Continue", onClick: () => { this.ui.hidePopup(); this._exitToSpawn(); } }],
        });
    }

    _failTimeTrial() {
        if (this._failing) return; // remaining stays <= 0 across several frames — only fire once
        this._failing = true;
        this.player.setFrozen(true);
        this.ui.showPopup({
            title: "Time's Up!",
            message: `You collected ${this.orbsCollected}/${TIME_TRIAL_ORB_COUNT} orbs.`,
            buttons: [{ label: "Continue", onClick: () => { this.ui.hidePopup(); this._exitToSpawn(); } }],
        });
    }

    // Ends the current run, resets to "no mode selected", and teleports the
    // player back to Spawn — used after a Free Roam restart, a Speedrun/
    // Time Trial finish, or a Time Trial timeout.
    _exitToSpawn() {
        this._resetRunState();
        this.mode = null;
        this.runStarted = false;
        this.ui.setMode(null);

        // StartTrigger blocks again until a new mode is chosen.
        if (this.startTriggerBody && !this.startTriggerBlocking) {
            this.world.addBody(this.startTriggerBody);
            this.startTriggerBlocking = true;
        }

        this.hotspotSystem.restoreAll();

        const spawn = this.respawnSystem.spawnPosition;
        this.ballBody.position.set(spawn.x, spawn.y, spawn.z);
        this.ballBody.velocity.set(0, 0, 0);
        this.ballBody.angularVelocity.set(0, 0, 0);
        this.respawnSystem.lastSafePosition.copy(spawn);
        this.respawnSystem.resetGroundedHistory(spawn);

        this.player.setFrozen(false);
    }

    _resetRunState() {
        this._clearOrbs();
        this.orbsCollected = 0;
        this.speedrunElapsed = 0;
        this.timeTrialRemaining = TIME_TRIAL_DURATION;
        this.insideStart = false;
        this.insideEnd = false;
        this._pendingStartLock = false;
        this._failing = false;
    }

    // Fisher–Yates partial shuffle to pull TIME_TRIAL_ORB_COUNT random,
    // non-repeating picks out of the ~124 authored Sphere markers, then
    // spawns a small glowing orb — bloom-enabled, same pattern as
    // GlowPath/HotspotSystem's emissive markers — at each one's center. Its
    // pickup hitbox is that same Sphere marker's own world-space bounding
    // radius (see onLevelLoaded).
    _spawnOrbs() {
        this._clearOrbs();

        const pool = [...this.collectableCandidates];
        for (let i = pool.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [pool[i], pool[j]] = [pool[j], pool[i]];
        }
        const picks = pool.slice(0, Math.min(TIME_TRIAL_ORB_COUNT, pool.length));

        for (const { center, radius } of picks) {
            const geo = new THREE.SphereGeometry(radius, 16, 16);
            const mat = new THREE.MeshStandardMaterial({
                color: ORB_COLOR,
                emissive: ORB_COLOR,
                emissiveIntensity: 2.4,
                roughness: 0.3,
                metalness: 0,
                toneMapped: false, // let emissive push past 1.0 so bloom actually picks it up
            });
            const mesh = new THREE.Mesh(geo, mat);
            mesh.position.copy(center);
            mesh.layers.enable(BLOOM_LAYER);
            this.scene.add(mesh);
            this.activeOrbs.push({ mesh, center: center.clone(), radius });
        }
    }

    _checkOrbPickups(ballPosition) {
        for (let i = this.activeOrbs.length - 1; i >= 0; i--) {
            const orb = this.activeOrbs[i];
            if (ballPosition.distanceTo(orb.center) <= orb.radius + BALL_RADIUS) {
                this.scene.remove(orb.mesh);
                orb.mesh.geometry.dispose();
                orb.mesh.material.dispose();
                this.activeOrbs.splice(i, 1);
                this.orbsCollected++;
                this.ui.setOrbCount(this.orbsCollected, TIME_TRIAL_ORB_COUNT);
                this.audioManager.playHotspotSound(0.35);
            }
        }
    }

    _clearOrbs() {
        for (const orb of this.activeOrbs) {
            this.scene.remove(orb.mesh);
            orb.mesh.geometry.dispose();
            orb.mesh.material.dispose();
        }
        this.activeOrbs.length = 0;
    }

    _formatTime(seconds) {
        const m = Math.floor(seconds / 60);
        const s = (seconds % 60).toFixed(2).padStart(5, "0");
        return `${m}:${s}`;
    }
}