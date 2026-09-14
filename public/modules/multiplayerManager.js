import * as THREE from "three";
import * as CANNON from "cannon-es";
import { MultiplayerClient } from "./multiplayerClient.js";
import {
    BALL_RADIUS,
    BLOOM_LAYER,
    MAX_SPEED,
    MP_DEFAULT_PORT,
    MP_TOTAL_ROUNDS,
    MP_COUNTDOWN_SECONDS,
    MP_ROUND_END_DISPLAY_SECONDS,
    MP_TRANSFORM_SEND_HZ,
    MP_GUEST_BALL_COLOR,
    MP_HOST_ORB_COLOR,
    MP_GUEST_ORB_COLOR,
    MP_REMOTE_BALL_SMOOTHING,
    MP_MAX_SPEED,
} from "./config.js";

const ROLE_LABEL = { host: "Host", guest: "Guest" };
const OTHER_ROLE = { host: "guest", guest: "host" };

// Owns everything specific to the "2-Player Rush" mode: the host/join
// screen rendered inside Hotspot_1's popup, the persistent status/exit
// overlay, the networked opponent's visual+physics proxy, orb spawn/
// collection, the per-round hotspot teleport + 5s countdown, and the
// round/game-winner overlays. Talks to the network purely through
// MultiplayerClient (multiplayerClient.js) — this class has zero WebSocket
// code of its own.
//
// Deliberately does NOT reuse GameModeManager's mode machinery: selecting
// a normal mode (Free Roam/Speedrun/Time Trial) makes StartTrigger
// passable immediately, but a 2-Player Rush host has to stay penned in the
// spawn room (StartTrigger still solid, Hotspot_1 pulled out of play) until
// a guest actually connects — see hotspotSystem.js's comment on why its
// "2-Player rush" Select button skips context.onSelectMode entirely.
export class MultiplayerManager {
    constructor({
        scene,
        world,
        ballMesh,
        ballBody,
        ballMaterial,
        player,
        audioManager,
        hotspotSystem,
        routeTriggerSystem,
        playerEntrance,
        gameModeManager,
        createBallVisual, // ball.js's createBall(scene, world, ballMaterial)
        getSpawnPos, // () => THREE.Vector3 | null — the level's authored Spawn point
    }) {
        this.scene = scene;
        this.world = world;
        this.ballMesh = ballMesh;
        this.ballBody = ballBody;
        this.ballMaterial = ballMaterial;
        this.player = player;
        this.audioManager = audioManager;
        this.hotspotSystem = hotspotSystem;
        this.routeTriggerSystem = routeTriggerSystem;
        this.playerEntrance = playerEntrance;
        this.gameModeManager = gameModeManager;
        this.createBallVisual = createBallVisual;
        this.getSpawnPos = getSpawnPos;

        this.client = null;
        this.role = null; // "host" | "guest" | null
        this.phase = "idle"; // idle -> lobby -> countdown -> playing -> round_over -> game_over

        this.remote = null; // { mesh, body, ready, target:{x,y,z,qx,qy,qz,qw}, colored }
        this.orbs = new Map(); // orbId -> { mesh, owner }
        this.scores = { host: 0, guest: 0 };
        this.round = 0;

        this._sendAccumulator = 0;
        this._ballTinted = false;

        this._overlays = {}; // DOM nodes created for the current session, torn down on end
    }

    // ── Entry point from hotspotSystem.js's "2-Player rush" Select button ──
    showHostJoinScreen(containerEl) {
        containerEl.innerHTML = `
            <p style="opacity:.75;font-size:.85em;">Host from this machine, or connect to someone else's game.</p>
            <div style="display:flex; gap:10px; margin-top:10px;">
                <button data-mp-host style="flex:1;">Host Game</button>
                <button data-mp-join style="flex:1;">Join Server</button>
            </div>
            <div data-mp-status style="margin-top:10px; font-size:.8em; opacity:.8; min-height:1.2em;"></div>
        `;

        const statusEl = containerEl.querySelector("[data-mp-status]");

        containerEl.querySelector("[data-mp-host]").addEventListener("click", () => {
            statusEl.textContent = "Starting local server connection…";
            this._startHosting(statusEl);
        });

        containerEl.querySelector("[data-mp-join]").addEventListener("click", () => {
            this._showJoinForm(containerEl, statusEl);
        });
    }

    _showJoinForm(containerEl, statusEl) {
        containerEl.querySelector("div").outerHTML = `
            <div style="display:flex; gap:10px; margin-top:10px;">
                <input data-mp-ip type="text" placeholder="Host IP, e.g. 192.168.1.42"
                    style="flex:1; padding:6px 8px; border-radius:6px; border:1px solid rgba(255,255,255,.25); background:rgba(0,0,0,.3); color:#fff;">
                <button data-mp-connect>Connect</button>
            </div>
        `;
        const input = containerEl.querySelector("[data-mp-ip]");
        const connectBtn = containerEl.querySelector("[data-mp-connect]");
        connectBtn.addEventListener("click", () => {
            const ip = input.value.trim();
            if (!ip) {
                statusEl.textContent = "Enter the host's IP address first.";
                return;
            }
            statusEl.textContent = `Connecting to ${ip}…`;
            this._joinServer(ip, statusEl);
        });
        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") connectBtn.click();
        });
    }

    // ── Hosting ──
    async _startHosting(statusEl) {
        const client = new MultiplayerClient();
        try {
            await client.connect("localhost", MP_DEFAULT_PORT, "host");
        } catch (err) {
            statusEl.textContent =
                `Couldn't reach the multiplayer server on this machine (${err.message}). ` +
                `Run "node server/multiplayerServer.js" first, then try again.`;
            return;
        }

        this.client = client;
        this.role = "host";
        this.phase = "lobby";
        this._wireCommonHandlers();

        // Report the level-authored data the server needs but doesn't load
        // itself (it never touches the GLB — see server/multiplayerServer.js).
        client.send("collectables", {
            points: (this.gameModeManager.getCollectableCandidates() || []).map((c, i) => ({
                idx: i,
                x: c.center.x,
                y: c.center.y,
                z: c.center.z,
            })),
        });
        client.send("hotspots", {
            points: this.hotspotSystem.hotspots.map((h) => ({
                name: h.name,
                x: h.position.x,
                y: h.position.y,
                z: h.position.z,
            })),
        });

        // The host is already standing in the world (that's how they got to
        // Hotspot_1 in the first place) — no entrance animation to wait on.
        client.send("entrance_done");

        this._applyLockdown();
        this._buildStatusOverlay("Waiting for players to join…", true);
        this._buildExitButton("Exit 2-Player Rush");
    }

    // ── Joining ──
    async _joinServer(ip, statusEl) {
        const client = new MultiplayerClient();
        try {
            await client.connect(ip, MP_DEFAULT_PORT, "guest");
        } catch (err) {
            statusEl.textContent = err.message;
            return;
        }

        this.client = client;
        this.role = "guest";
        this.phase = "lobby";
        this._wireCommonHandlers();

        this.hotspotSystem.closePopup?.();
        this._applyLockdown();
        this._buildStatusOverlay("Connected — waiting for the host to start…", false);
        this._buildExitButton("Leave Game");

        // Guest color, applied to THIS client's own real ball.
        this._tintOwnBall(MP_GUEST_BALL_COLOR);

        // "the guest will still undergo the entrance animation at Spawn"
        const spawnPos = this.getSpawnPos && this.getSpawnPos();
        if (spawnPos) {
            this.ballBody.position.set(spawnPos.x, spawnPos.y, spawnPos.z);
            this.ballBody.velocity.set(0, 0, 0);
            this.ballBody.angularVelocity.set(0, 0, 0);
            this.ballMesh.visible = false;
            this.player.setFrozen(true);
            this.playerEntrance.play(spawnPos, () => {
                client.send("entrance_done");
            });
        } else {
            // No authored Spawn node found for this level — skip the
            // animation rather than block the session on it.
            client.send("entrance_done");
        }
    }

    // ── Shared setup once a role is confirmed ──
    _wireCommonHandlers() {
        const c = this.client;

        c.on("guest_joined", () => {
            if (this.role === "host") this._setStatusText("A guest connected — waiting for their spawn animation…");
        });

        c.on("ready_to_start", () => {
            if (this.role === "host") this._showStartButton();
        });

        c.on("waiting_for_host_start", () => {
            if (this.role === "guest") this._setStatusText("Both players are in. Waiting for the host to start…");
        });

        c.on("round_start", (msg) => this._onRoundStart(msg));
        c.on("countdown", (msg) => this._onCountdown(msg.secondsLeft));
        c.on("go", () => this._onGo());
        c.on("orb_ack", (msg) => this._onOrbAck(msg));
        c.on("round_over", (msg) => this._onRoundOver(msg));
        c.on("game_over", (msg) => this._onGameOver(msg));
        c.on("opponent_left", () => this._onOpponentLeft());
        c.on("state", (msg) => this._onRemoteState(msg));
        c.on("_socket_closed", () => {
            if (this.phase !== "idle") this._onOpponentLeft();
        });
    }

    // ── Host lockdown (also applied to the guest, for symmetry — neither
    // side should be able to wander into another mode or navigate away
    // mid-match) ──
    _applyLockdown() {
        // Every hotspot doubles as a per-round spawn point in this mode
        // (see _onRoundStart) — the player only ever needs to be
        // teleported onto one, never to see or trigger its popup, so all
        // of them (not just Hotspot_1) get pulled out of play for the
        // whole session.
        this.hotspotSystem.hideAll();
        this.routeTriggerSystem.setActive(false);
    }

    _releaseLockdown() {
        this.hotspotSystem.restoreAll();
        this.routeTriggerSystem.setActive(true);
    }

    // ── Remote player proxy ──
    // A KINEMATIC cannon-es body driven directly by the network's reported
    // position/rotation (never by forces/gravity), plus a plain visual ball
    // matching the local player's own — see config.js's MP_REMOTE_BALL_
    // SMOOTHING comment for why this still produces a believable two-way
    // shove even though neither machine ever simulates true two-body
    // dynamics.
    _ensureRemoteBall() {
        if (this.remote) return;

        const { ballMesh: mesh, ballBody: body, ready } = this.createBallVisual(
            this.scene,
            this.world,
            this.ballMaterial
        );
        body.type = CANNON.Body.KINEMATIC;
        body.mass = 0;
        body.updateMassProperties();
        body.allowSleep = false;

        this.remote = {
            mesh,
            body,
            target: { x: mesh.position.x, y: mesh.position.y, z: mesh.position.z, qx: 0, qy: 0, qz: 0, qw: 1 },
            colorApplied: false,
        };

        ready.then(() => {
            const opponentRole = OTHER_ROLE[this.role];
            if (opponentRole === "guest") this._tintGroup(mesh, MP_GUEST_BALL_COLOR);
        });
    }

    _removeRemoteBall() {
        if (!this.remote) return;
        this.scene.remove(this.remote.mesh);
        this.world.removeBody(this.remote.body);
        this.remote = null;
    }

    _onRemoteState(msg) {
        this._ensureRemoteBall();
        this.remote.target.x = msg.x;
        this.remote.target.y = msg.y;
        this.remote.target.z = msg.z;
        this.remote.target.qx = msg.qx;
        this.remote.target.qy = msg.qy;
        this.remote.target.qz = msg.qz;
        this.remote.target.qw = msg.qw;
    }

    // ── Ball tinting ──
    _tintOwnBall(hexColor) {
        if (this._ballTinted) return;
        this._ballTinted = true;
        // The GLB may already be loaded (host case) or still loading — if
        // it's not there yet, retry on the next couple of frames rather
        // than depending on a second promise wired through main.js.
        const tryTint = () => {
            if (this.ballMesh.children.length === 0) {
                requestAnimationFrame(tryTint);
                return;
            }
            this._tintGroup(this.ballMesh, hexColor);
        };
        tryTint();
    }

    _tintGroup(group, hexColor) {
        const color = new THREE.Color(hexColor);
        group.traverse((child) => {
            if (!child.isMesh || !child.material) return;
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            for (const mat of mats) {
                if (mat.color) mat.color.copy(color);
            }
        });
    }

    // ── Round lifecycle ──
    _onRoundStart(msg) {
        // Fires (via the server's broadcast) on both the host's and the
        // guest's client the moment the host clicks "Start 2-Player Rush"
        // — the one event both sides actually receive for "the game has
        // begun", so this is where StartTrigger opens up and the match
        // speed cap kicks in for this client's own ball. Harmless to
        // repeat on round 2/3's round_start too, since both are already
        // in the states being set.
        this.gameModeManager.setStartTriggerPassable(true);
        this.player.setMaxSpeed(MP_MAX_SPEED);
        this.audioManager.setMaxSpeed(MP_MAX_SPEED);

        this.phase = "countdown";
        this.round = msg.round;
        this.scores = msg.scores;
        this._clearOrbs();

        for (const orb of msg.orbs) {
            const color = orb.owner === "host" ? MP_HOST_ORB_COLOR : MP_GUEST_ORB_COLOR;
            const mesh = this._spawnOrbMesh(orb.x, orb.y, orb.z, color);
            this.orbs.set(orb.id, { mesh, owner: orb.owner, x: orb.x, y: orb.y, z: orb.z });
        }

        const myHotspotName = msg.hotspots[this.role];
        const hotspot = myHotspotName && this.hotspotSystem.hotspots.find((h) => h.name === myHotspotName);
        if (hotspot) {
            const pos = hotspot.position;
            this.ballBody.position.set(pos.x, pos.y + 0.6, pos.z);
            this.ballBody.velocity.set(0, 0, 0);
            this.ballBody.angularVelocity.set(0, 0, 0);
        }

        this.player.setFrozen(true);
        this._setRoundHUD(`Round ${msg.round} of ${msg.totalRounds} — ${msg.orbCount} orbs each`);
        this._setCountdownText(String(MP_COUNTDOWN_SECONDS));
    }

    _onCountdown(secondsLeft) {
        this._setCountdownText(secondsLeft > 0 ? String(secondsLeft) : "GO!");
    }

    _onGo() {
        this.phase = "playing";
        this.player.setFrozen(false);
        this._setCountdownText(null);
    }

    _spawnOrbMesh(x, y, z, hexColor) {
        const geometry = new THREE.SphereGeometry(0.32, 16, 16);
        const material = new THREE.MeshStandardMaterial({
            color: hexColor,
            emissive: hexColor,
            emissiveIntensity: 1.8,
            roughness: 0.3,
            metalness: 0,
            toneMapped: false, // let emissive push past 1.0 so bloom actually picks it up
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.set(x, y, z);
        // Was missing — same BLOOM_LAYER treatment GameModeManager's own
        // orbs get (see gameModeManager.js's _createOrb) — without this
        // the orb never feeds BloomRenderer's isolated bloom pass, so it
        // rendered as a flat, unlit-looking sphere despite the emissive
        // material above.
        mesh.layers.enable(BLOOM_LAYER);
        this.scene.add(mesh);
        return mesh;
    }

    _clearOrbs() {
        for (const { mesh } of this.orbs.values()) {
            this.scene.remove(mesh);
            mesh.geometry.dispose();
            mesh.material.dispose();
        }
        this.orbs.clear();
    }

    _onOrbAck(msg) {
        const orb = this.orbs.get(msg.orbId);
        if (!orb) return;
        this.scene.remove(orb.mesh);
        orb.mesh.geometry.dispose();
        orb.mesh.material.dispose();
        this.orbs.delete(msg.orbId);
        if (msg.collectedBy === this.role) {
            this._updateOwnOrbCount();
        }
    }

    _updateOwnOrbCount() {
        let remaining = 0;
        for (const orb of this.orbs.values()) if (orb.owner === this.role) remaining++;
        this._setRoundHUD(`Round ${this.round} — ${remaining} orb${remaining === 1 ? "" : "s"} left`);
    }

    _onRoundOver(msg) {
        this.phase = "round_over";
        this.scores = msg.scores;
        this.player.setFrozen(true);
        this._setCountdownText(null);
        this._setWinnerText(`${ROLE_LABEL[msg.winner]} Won Round ${msg.round}`);

        if (msg.isFinalRound) {
            // Server waits MP_ROUND_END_DISPLAY_SECONDS then sends
            // game_over — swap this message for the game-winner one right
            // as that arrives (see _onGameOver), rather than on a second
            // independent timer that could drift out of sync with it.
        }
    }

    _onGameOver(msg) {
        this.phase = "game_over";
        this._setWinnerText(`Winner of the Game: ${ROLE_LABEL[msg.winner]}`);
        setTimeout(() => this._endSession(), MP_ROUND_END_DISPLAY_SECONDS * 1000);
    }

    _onOpponentLeft() {
        if (this.phase === "idle") return;
        this._setStatusText("The other player disconnected — 2-Player Rush ended.");
        this._setWinnerText(null);
        this._setCountdownText(null);
        setTimeout(() => this._endSession(), 1500);
    }

    _startGameClicked() {
        this.client.send("start_game");
    }

    // ── Per-frame hooks (called from main.js's animate()) ──
    // preStep runs BEFORE world.step() so the remote kinematic proxy's
    // position is current for that step's collision pass; update runs
    // after, alongside every other per-frame system.
    preStep() {
        if (!this.remote) return;
        const t = this.remote.target;
        const b = this.remote.body;
        const s = MP_REMOTE_BALL_SMOOTHING;
        b.position.x += (t.x - b.position.x) * s;
        b.position.y += (t.y - b.position.y) * s;
        b.position.z += (t.z - b.position.z) * s;
        b.quaternion.x = t.qx;
        b.quaternion.y = t.qy;
        b.quaternion.z = t.qz;
        b.quaternion.w = t.qw;
    }

    update(dt, elapsedTime, ballPosition, ballQuaternion) {
        if (!this.client || !this.client.connected) return;

        // Sync the remote proxy's render mesh from its physics body.
        if (this.remote) {
            this.remote.mesh.position.copy(this.remote.body.position);
            this.remote.mesh.quaternion.copy(this.remote.body.quaternion);
        }

        // Throttled local transform broadcast.
        this._sendAccumulator += dt;
        const interval = 1 / MP_TRANSFORM_SEND_HZ;
        if (this._sendAccumulator >= interval) {
            this._sendAccumulator = 0;
            this.client.send("transform", {
                x: ballPosition.x,
                y: ballPosition.y,
                z: ballPosition.z,
                qx: ballQuaternion.x,
                qy: ballQuaternion.y,
                qz: ballQuaternion.z,
                qw: ballQuaternion.w,
            });
        }

        // Local orb-pickup detection — server has final say (see
        // server/multiplayerServer.js's _handleOrbCollected), this just
        // decides when to *ask*.
        if (this.phase === "playing") {
            for (const [orbId, orb] of this.orbs) {
                if (orb.owner !== this.role) continue; // can't collect the opponent's orbs
                const dx = ballPosition.x - orb.x;
                const dy = ballPosition.y - orb.y;
                const dz = ballPosition.z - orb.z;
                const distSq = dx * dx + dy * dy + dz * dz;
                const pickupRadius = BALL_RADIUS + 0.35;
                if (distSq <= pickupRadius * pickupRadius) {
                    this.client.send("orb_collected", { orbId });
                }
            }
        }
    }

    // ── UI ──
    _buildStatusOverlay(text, showStartButtonSlot) {
        const el = document.createElement("div");
        el.style.cssText = `
            position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%);
            z-index: 2000; background: rgba(10,10,14,0.82); color: #fff;
            font-family: inherit; font-size: 14px; padding: 12px 22px;
            border-radius: 10px; border: 1px solid rgba(255,255,255,0.15);
            text-align: center; backdrop-filter: blur(6px); min-width: 260px;
        `;
        el.innerHTML = `<div data-mp-status-text>${text}</div>`;
        document.body.appendChild(el);
        this._overlays.status = el;
        this._showStartButtonSlot = showStartButtonSlot;
    }

    _setStatusText(text) {
        const el = this._overlays.status?.querySelector("[data-mp-status-text]");
        if (el) el.textContent = text;
    }

    _showStartButton() {
        if (!this._overlays.status) return;
        this._overlays.status.innerHTML = "";
        const btn = document.createElement("button");
        btn.textContent = "Start 2-Player Rush";
        btn.style.cssText = "padding: 8px 20px; font-size: 14px; cursor: pointer;";
        btn.addEventListener("click", () => this._startGameClicked());
        this._overlays.status.appendChild(btn);
    }

    _buildExitButton(label) {
        const btn = document.createElement("button");
        btn.textContent = label;
        btn.style.cssText = `
            position: fixed; right: 24px; bottom: 24px; z-index: 2000;
            padding: 10px 18px; border-radius: 8px; cursor: pointer;
            background: rgba(180,30,30,0.85); color: #fff; border: 1px solid rgba(255,255,255,0.2);
            font-family: inherit; font-size: 13px; font-weight: 600;
        `;
        btn.addEventListener("click", () => this._endSession());
        document.body.appendChild(btn);
        this._overlays.exitBtn = btn;
    }

    _setCountdownText(text) {
        if (!text) {
            if (this._overlays.countdown) {
                this._overlays.countdown.remove();
                this._overlays.countdown = null;
            }
            return;
        }
        if (!this._overlays.countdown) {
            const el = document.createElement("div");
            el.style.cssText = `
                position: fixed; top: 38%; left: 50%; transform: translate(-50%, -50%);
                z-index: 2100; color: #fff; font-family: inherit; font-weight: 800;
                font-size: 72px; text-shadow: 0 4px 24px rgba(0,0,0,0.6); pointer-events: none;
            `;
            document.body.appendChild(el);
            this._overlays.countdown = el;
        }
        this._overlays.countdown.textContent = text;
    }

    _setWinnerText(text) {
        if (!text) {
            if (this._overlays.winner) {
                this._overlays.winner.remove();
                this._overlays.winner = null;
            }
            return;
        }
        if (this._overlays.winner) this._overlays.winner.remove();
        const el = document.createElement("div");
        el.style.cssText = `
            position: fixed; top: 30%; left: 50%; transform: translate(-50%, -50%);
            z-index: 2100; color: #fff; font-family: inherit; font-weight: 700;
            font-size: 34px; text-align: center; text-shadow: 0 4px 24px rgba(0,0,0,0.7);
            background: rgba(10,10,14,0.55); padding: 16px 32px; border-radius: 12px; pointer-events: none;
        `;
        el.textContent = text;
        document.body.appendChild(el);
        this._overlays.winner = el;
    }

    _setRoundHUD(text) {
        if (!this._overlays.roundHud) {
            const el = document.createElement("div");
            el.style.cssText = `
                position: fixed; top: 24px; left: 50%; transform: translateX(-50%);
                z-index: 1900; color: #fff; font-family: inherit; font-size: 15px;
                background: rgba(10,10,14,0.6); padding: 8px 18px; border-radius: 8px;
            `;
            document.body.appendChild(el);
            this._overlays.roundHud = el;
        }
        this._overlays.roundHud.textContent = text;
    }

    // ── Teardown ──
    _endSession() {
        if (this.client) this.client.disconnect();
        this.client = null;
        this.role = null;
        this.phase = "idle";
        this.round = 0;

        this._clearOrbs();
        this._removeRemoteBall();
        this._releaseLockdown();
        this.player.setFrozen(false);

        // Mirror GameModeManager's own _exitToSpawn() reset — StartTrigger
        // blocks again and the speed cap goes back to Free Roam's default,
        // same as leaving any other mode, since 2-Player Rush never routes
        // through selectMode()/that reset itself.
        this.gameModeManager.setStartTriggerPassable(false);
        this.player.setMaxSpeed(MAX_SPEED);
        this.audioManager.setMaxSpeed(MAX_SPEED);

        for (const key of Object.keys(this._overlays)) {
            this._overlays[key]?.remove();
        }
        this._overlays = {};

        // Note: a tinted local ball (guest) is deliberately left tinted —
        // this.ballMesh is the same GLB instance for the rest of the page's
        // life, and there's no clean "was this material originally red or
        // did the level author it some other way" to restore to without
        // caching the pre-tint colors. Refreshing the page (leaving and
        // re-entering the level) resets it, same as every other per-session
        // visual state in this game.
        this._ballTinted = false;
    }
}