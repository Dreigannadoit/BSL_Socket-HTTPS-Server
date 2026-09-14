# 2-Player Rush — Multiplayer Setup & Notes

## Why there's a `server/` folder

Per the earlier feasibility discussion: BSL's own socket library
(`lib/socket.bzg`, wrapping `BSL_Socket`) only exposes blocking calls —
`socket_accept()` is documented as blocking, and there's no `select`/
`poll`/thread/fork anywhere in BSL. It can't hold two players' connections
open at once, so it can't be the multiplayer server. `src/http.bzg` keeps
doing exactly what it already did (serving the game's static files);
`server/multiplayerServer.js` (Node + `ws`) is the actual authoritative
server for a 2-Player Rush match — rounds, orb positions, hotspot
assignment, countdown, and scoring all live there so both browsers can't
disagree about who collected what first.

## Ports

- **5050** — BSL's static file server (`src/http.bzg`), unchanged.
- **5051** — your live-reload server (`scripts/dev-watch.js`'s
  `LIVERELOAD_PORT`), unchanged.
- **5150** — 2-Player Rush's game server (`MP_DEFAULT_PORT` in
  `config.js` / the default in `server/multiplayerServer.js`). Picked
  specifically to avoid the two ports above.

If 5150 ever collides with something else on your setup, change it in
exactly two places: `MP_DEFAULT_PORT` in `public/modules/config.js`, and
the `PORT` default in `server/multiplayerServer.js` (or just pass a port
number as an argument: `node server/multiplayerServer.js 6000` — but note
the client always dials `MP_DEFAULT_PORT` unless you also add a UI field
for it, so a custom port on the server needs a matching change on the
client side today).

## Running it

```
npm install
npm run mp-server            # starts the game server on port 5150
```

Run this on whichever machine is going to **host**. In another terminal on
that same machine, run your normal dev server (`npm run dev-watch` or
`npm run server-only`) like you already do. The host's browser then opens
the game as usual and clicks **Host Game**; the guest's browser opens the
game (served from the host's LAN IP — see the earlier two-PC LAN
instructions) and clicks **Join Server**, entering the host's LAN IP.

Both the BSL static server (5050) and the multiplayer server (5150) need
their ports open in the host's firewall for a second PC to reach either
one — same `netsh advfirewall` steps as before, just add a rule for 5150
too (your existing 5051 rule, if any, is for live-reload only and isn't
needed by a guest at all — live-reload is a dev-time convenience on the
host's own machine).

## What's implemented

- **`server/multiplayerServer.js`** — the authoritative game server: role
  assignment (host/guest), round progression (3 rounds, 10/20/30 orbs),
  orb allocation from the level's real `Collectables` pool (124 authored
  points in `maze_platform_high.glb` — confirmed by inspecting the GLB
  directly; the GLB is unchanged between the version you sent originally
  and this one, so that count still holds), hotspot rotation (no repeat
  vs. your own last round, never the same hotspot as your opponent this
  round), 5-second countdown, scoring, and final-winner determination.
  Verified with a standalone test harness simulating a full host+guest
  session end-to-end (round progression, no duplicate orb positions,
  correct hotspot rotation, correct scoring matching the exact worked
  example from your spec, correct rejection of a guest joining with no
  host / a duplicate host / a 3rd player) — the game-logic layer works as
  designed.
- **`public/modules/multiplayerClient.js`** — thin WebSocket wrapper.
- **`public/modules/multiplayerManager.js`** — everything else: the host/
  join screen inside Hotspot_1's "2-Player rush" slide, the persistent
  "waiting for players" / network status bar, the "Exit 2-Player Rush"
  button, host lockdown (`Hotspot_1` hidden, `RouteBasedTriggers`
  disabled, `StartTrigger` left blocking — so the host stays penned in the
  spawn room exactly as described), the guest's re-triggered spawn
  entrance + green recolor, orb spawning/collection with per-owner colors,
  the networked opponent rendered as a `CANNON.Body.KINEMATIC` proxy (so
  it still physically pushes the local ball — real collision, not a
  visual fake), round countdown/HUD, and the round-winner → game-winner
  overlay sequence.
- **`hotspotSystem.js` / `routeTriggerSystem.js` / `gameModeManager.js`** —
  small, additive hooks (`setHotspotHidden`, `setActive`,
  `getCollectableCandidates`) plus the "2-Player rush" slide itself
  (previously your "coming soon" placeholder, now active alongside your
  own newer Spawn Chase mode) — nothing else in these files touched.

This was rebuilt against the codebase you just sent (not the one from
earlier in this conversation) — it accounts for your new Spawn Chase
mode, background music system, and control-tutorial hint, none of which
existed in the version I originally built against. I diffed both
codebases file-by-file before touching anything, specifically so this
patch wouldn't clobber that new work.

## What I could verify vs. what still needs an in-browser pass

I can run and test the Node game-server logic directly (see above — it's
been exercised end-to-end, including on this exact updated codebase's
port), but I don't have a way to actually run this project's Three.js/
cannon-es/WebGL client in this environment to click through it myself.
The client-side half (`multiplayerManager.js` and the `hotspotSystem.js`
UI changes) is written against the real APIs already in your codebase
(`PlayerController.setFrozen()`, `HotspotSystem.hotspots`,
`PlayerEntrance.play(pos, onComplete)`, `createBall()`, etc.) and passes a
plain JS syntax check, but it hasn't been exercised in an actual browser.
Things most worth checking first when you test on real hardware:

- The host/join screen's styling — it's unstyled inline CSS right now,
  matching function over form; you'll likely want to reskin it to match
  `style.css`'s existing look.
- The remote player's kinematic-proxy collision feel (`MP_REMOTE_BALL_
  SMOOTHING` in `config.js` — lower it for a snappier/twitchier remote
  ball, raise it for smoother-but-laggier).
- Orb pickup radius (`BALL_RADIUS + 0.22` in `multiplayerManager.js`) —
  tune to taste.
- The guest's ball recolor (`_tintGroup`) does a flat material color
  overwrite, which will look different depending on what materials
  `ball.glb` actually uses (untested against the real model in a
  browser).
- `multiplayerManager.js` doesn't touch `backgroundMusic`/`musicToggleUI`
  at all right now — if you want the "rush" music track (referenced in
  `GameModeManager`'s crossfade comments) to also play during a
  2-Player Rush match, that's a small addition to wire in, not something
  currently there.

## Extending past 2 players later

The parts of `multiplayerServer.js` that assign hotspots/orbs already loop
over however many roles are connected, not a hardcoded pair — see
`_allocateHotspots()`/`_allocateOrbs()`. The one real 2-player assumption
is `_identify()` only ever handing out the literal roles `"host"`/
`"guest"`; extending `ROLES` to `["host", "guest2", "guest3", "guest4"]`
and updating `_identify()`'s guest-slot logic is the main piece of work
left for a 3-5 player version.
