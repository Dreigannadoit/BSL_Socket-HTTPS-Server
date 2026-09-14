/*
    2-Player Rush — Authoritative Multiplayer Server
    -------------------------------------------------
    Runs alongside the BSL static file server (src/http.bzg). BSL cannot do
    this part — see the earlier feasibility discussion: BSL_Socket's
    socket_accept() is documented as blocking, there's no select/poll/
    thread/fork primitive anywhere in the BSL ecosystem, so it can't hold
    open multiple simultaneous connections. Node + `ws` can, so this process
    is the "room" both browsers connect to.

    Run on the HOST's machine only:
        npm install
        node server/multiplayerServer.js            (defaults to port 5150)
        node server/multiplayerServer.js 6000        (custom port)

    The host's own browser connects to ws://localhost:5150 (or the host's
    LAN IP — same as BSL, see the earlier two-PC LAN instructions). The
    guest's browser connects to ws://<host-LAN-IP>:5150.

    Port 5150 is deliberately NOT 5050 (BSL's own static file server) or
    5051 (scripts/dev-watch.js's live-reload SSE server) — both already in
    use on the host's machine.

    This server is the single source of truth for: who is host/guest, round
    number, orb positions + which are collected, hotspot assignments each
    round, the 5-second countdown, and round/game scoring. Both browsers are
    "dumb" renderers of whatever this process tells them — that avoids any
    host-vs-guest desync argument about who actually got an orb first.

    NOTE on scaling to 3-5 players (asked for as a "for now, 2 is enough"
    future item): the shapes below (`players` Map, `ROLES` array, hotspot/
    orb allocation loops) are already written generically over N players,
    not hardcoded to exactly two — see the comments in _startRound() and
    _allocateHotspots(). The one hard 2-player assumption is `_identify()`
    only ever assigning the literal roles "host" and "guest"; extending
    that to "guest2".."guest4" is the only real change needed later.
*/

const { WebSocketServer } = require("ws");

const PORT = Number(process.argv[2]) || 5150;
const TOTAL_ROUNDS = 3;
const ORB_COUNTS_BY_ROUND = [10, 20, 30]; // index 0 = round 1
const COUNTDOWN_SECONDS = 5;
const ROUND_END_DISPLAY_SECONDS = 3;

const ROLES = ["host", "guest"]; // order matters: host is always ROLES[0]

function shuffled(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

// One global "room" — this process is meant to be run per-host-machine,
// one game at a time, so there's no multi-room lobby system to build.
function createRoom() {
    return {
        phase: "lobby", // lobby -> countdown -> playing -> round_over -> game_over
        round: 0,
        scores: { host: 0, guest: 0 },
        lastHotspot: { host: null, guest: null },
        orbsRemaining: { host: 0, guest: 0 },
        collectedIds: new Set(),
        collectablePool: null, // [{ idx, x, y, z, radius }] — reported by host
        hotspotPool: null,     // [{ name, x, y, z }] — reported by host
        countdownHandle: null,
        roundEndHandle: null,
        players: new Map(), // ws -> { id, role, entranceDone, ready }
    };
}

let room = createRoom();

function playerByRole(role) {
    for (const p of room.players.values()) if (p.role === role) return p;
    return null;
}

function send(ws, msg) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(msg, exceptWs = null) {
    for (const ws of room.players.keys()) {
        if (ws !== exceptWs) send(ws, msg);
    }
}

function resetRoomKeepingNothing() {
    if (room.countdownHandle) clearInterval(room.countdownHandle);
    if (room.roundEndHandle) clearTimeout(room.roundEndHandle);
    room = createRoom();
}

function bothConnected() {
    return playerByRole("host") && playerByRole("guest");
}

function maybeAnnounceReadyToStart() {
    if (room.phase !== "lobby") return;
    const host = playerByRole("host");
    const guest = playerByRole("guest");
    if (host && guest && host.entranceDone && guest.entranceDone) {
        send(host.ws, { type: "ready_to_start" });
        send(guest.ws, { type: "waiting_for_host_start" });
    }
}

// Picks one hotspot per connected role, all distinct from each other and
// (where possible) distinct from that role's own hotspot last round.
// Generic over however many roles are currently connected.
function _allocateHotspots() {
    const pool = room.hotspotPool && room.hotspotPool.length ? room.hotspotPool : null;
    const roles = ROLES.filter((r) => playerByRole(r));
    const assignment = {};
    if (!pool) {
        roles.forEach((r) => (assignment[r] = null));
        return assignment;
    }

    const used = new Set();
    for (const role of roles) {
        let candidates = shuffled(pool).filter(
            (h) => !used.has(h.name) && h.name !== room.lastHotspot[role]
        );
        if (candidates.length === 0) {
            // Pool too small to satisfy both constraints at once (e.g. only
            // as many hotspots as players) — relax the "not last round"
            // rule rather than fail to assign anything.
            candidates = shuffled(pool).filter((h) => !used.has(h.name));
        }
        if (candidates.length === 0) {
            // Still nothing (more players than hotspots) — allow repeats
            // as an absolute last resort.
            candidates = shuffled(pool);
        }
        const pick = candidates[0];
        assignment[role] = pick ? pick.name : null;
        if (pick) used.add(pick.name);
    }
    return assignment;
}

// Splits orbCount*roles.length distinct points out of the collectable pool
// so no two players (of any role) ever get the same orb position.
function _allocateOrbs(orbCount, round) {
    const roles = ROLES.filter((r) => playerByRole(r));
    const pool = room.collectablePool || [];
    const needed = orbCount * roles.length;
    const picks = shuffled(pool).slice(0, needed);

    const orbsByRole = {};
    room.orbsRemaining = {};
    let cursor = 0;
    for (const role of roles) {
        const mine = picks.slice(cursor, cursor + orbCount).map((p, i) => ({
            id: `${role}_r${round}_${i}`,
            owner: role,
            x: p.x,
            y: p.y,
            z: p.z,
        }));
        cursor += orbCount;
        orbsByRole[role] = mine;
        room.orbsRemaining[role] = mine.length;
    }
    return orbsByRole;
}

function _startRound() {
    room.round += 1;
    room.phase = "countdown";
    room.collectedIds.clear();

    const orbCount = ORB_COUNTS_BY_ROUND[Math.min(room.round, ORB_COUNTS_BY_ROUND.length) - 1];
    const hotspotAssignment = _allocateHotspots();
    const orbsByRole = _allocateOrbs(orbCount, room.round);

    // Remember this round's hotspot for next round's "don't repeat" check.
    for (const role of Object.keys(hotspotAssignment)) {
        if (hotspotAssignment[role]) room.lastHotspot[role] = hotspotAssignment[role];
    }

    const allOrbs = Object.values(orbsByRole).flat();

    broadcast({
        type: "round_start",
        round: room.round,
        totalRounds: TOTAL_ROUNDS,
        orbCount,
        hotspots: hotspotAssignment, // { host: "Hotspot_3", guest: "Hotspot_1" }
        orbs: allOrbs,               // every orb, both owners — client filters by color/owner for pickup rights
        scores: room.scores,
    });

    let secondsLeft = COUNTDOWN_SECONDS;
    broadcast({ type: "countdown", secondsLeft });
    room.countdownHandle = setInterval(() => {
        secondsLeft -= 1;
        if (secondsLeft <= 0) {
            clearInterval(room.countdownHandle);
            room.countdownHandle = null;
            room.phase = "playing";
            broadcast({ type: "go" });
        } else {
            broadcast({ type: "countdown", secondsLeft });
        }
    }, 1000);
}

function _endRound(winnerRole) {
    room.phase = "round_over";
    room.scores[winnerRole] = (room.scores[winnerRole] || 0) + 1;

    const isFinalRound = room.round >= TOTAL_ROUNDS;
    let gameWinner = null;
    if (isFinalRound) {
        gameWinner = Object.keys(room.scores).reduce((a, b) =>
            room.scores[a] >= room.scores[b] ? a : b
        );
    }

    broadcast({
        type: "round_over",
        round: room.round,
        winner: winnerRole,
        scores: room.scores,
        isFinalRound,
        gameWinner,
    });

    room.roundEndHandle = setTimeout(() => {
        if (isFinalRound) {
            room.phase = "game_over";
            broadcast({ type: "game_over", winner: gameWinner, scores: room.scores });
        } else if (bothConnected()) {
            _startRound();
        }
    }, ROUND_END_DISPLAY_SECONDS * 1000);
}

function _handleOrbCollected(player, orbId) {
    if (room.phase !== "playing") return;
    if (room.collectedIds.has(orbId)) return; // already claimed
    // orbId is always "<role>_r<round>_<i>" — enforce that only the owner
    // can claim it (mirrors "host can't collect guest's orbs" and vice versa).
    if (!orbId.startsWith(player.role + "_")) return;

    room.collectedIds.add(orbId);
    room.orbsRemaining[player.role] = Math.max(0, (room.orbsRemaining[player.role] || 1) - 1);

    broadcast({ type: "orb_ack", orbId, collectedBy: player.role });

    if (room.orbsRemaining[player.role] === 0) {
        _endRound(player.role);
    }
}

function _identify(ws, msg) {
    const requestedRole = msg.role === "host" ? "host" : "guest";

    if (requestedRole === "host") {
        if (playerByRole("host")) {
            send(ws, { type: "identify_error", reason: "A host is already running this session." });
            return;
        }
    } else {
        if (!playerByRole("host")) {
            send(ws, { type: "identify_error", reason: "No host is currently waiting on this server." });
            return;
        }
        if (playerByRole("guest")) {
            send(ws, { type: "identify_error", reason: "This 2-Player Rush session is already full." });
            return;
        }
        if (room.phase !== "lobby") {
            send(ws, { type: "identify_error", reason: "A round is already in progress." });
            return;
        }
    }

    const player = {
        id: `${requestedRole}-${Date.now()}`,
        role: requestedRole,
        entranceDone: false,
        ws,
    };
    room.players.set(ws, player);

    send(ws, { type: "role_assigned", role: requestedRole, playerId: player.id });

    if (requestedRole === "guest") {
        broadcast({ type: "guest_joined" }, ws);
    }
}

const wss = new WebSocketServer({ port: PORT });

wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw.toString());
        } catch {
            return;
        }

        if (msg.type === "identify") {
            _identify(ws, msg);
            return;
        }

        const player = room.players.get(ws);
        if (!player) return; // must identify() first

        switch (msg.type) {
            case "collectables":
                if (player.role === "host") room.collectablePool = msg.points;
                break;

            case "hotspots":
                if (player.role === "host") room.hotspotPool = msg.points;
                break;

            case "transform":
                // Relay-only — position/rotation sync, no game-state impact.
                broadcast(
                    { type: "state", role: player.role, x: msg.x, y: msg.y, z: msg.z, qx: msg.qx, qy: msg.qy, qz: msg.qz, qw: msg.qw },
                    ws
                );
                break;

            case "entrance_done":
                player.entranceDone = true;
                maybeAnnounceReadyToStart();
                break;

            case "start_game":
                if (player.role === "host" && room.phase === "lobby" && bothConnected()) {
                    _startRound();
                }
                break;

            case "orb_collected":
                _handleOrbCollected(player, msg.orbId);
                break;

            case "exit":
                ws.close();
                break;
        }
    });

    ws.on("close", () => {
        const player = room.players.get(ws);
        if (!player) return;
        room.players.delete(ws);
        broadcast({ type: "opponent_left", role: player.role });
        // Any disconnect ends the current session outright — with only 2
        // players there's no meaningful "keep playing" state once either
        // side drops. The remaining player's client returns to its own
        // idle/menu state and can host/join a fresh session.
        resetRoomKeepingNothing();
    });
});

console.log(`2-Player Rush server listening on ws://0.0.0.0:${PORT}`);
console.log(`Host's browser -> ws://localhost:${PORT}  (or the host's own LAN IP)`);
console.log(`Guest's browser -> ws://<host-LAN-IP>:${PORT}`);
