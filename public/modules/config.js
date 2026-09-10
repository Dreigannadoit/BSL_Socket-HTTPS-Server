// ── Asset locations ──
export const ASSET_BASE = "/assets/";
export const GLB_URL = ASSET_BASE + "maze_platform_high.glb";
// Alternate world loaded on the about page (about.html/about.js) instead of
// the normal maze — same loadLevel()/game logic, just a different GLB. See
// main.js's startGame({ levelUrl }).
export const ABOUT_GLB_URL = ASSET_BASE + "about_environment.glb";
export const BALL_GLB_URL = ASSET_BASE + "ball.glb";
// "Nebula Skybox 16k" by Jungle Jim (sketchfab.com/jungle_jim), CC-BY-4.0
// (https://creativecommons.org/licenses/by/4.0/) — license requires
// attribution wherever the game is shown (credits screen, README, etc.);
// sky.js only wires up the asset, it doesn't render a credits UI.
export const SKY_GLB_URL = ASSET_BASE + "nebula_skybox_16k.glb";

export const SOUND_FILES = {
    bounce1: "bounce1.mp3",
    bounce2: "bounce2.mp3",
    bounce3: "bounce3.mp3",
    bounce4: "bounce4.mp3",
    bounce5: "bounce5.mp3",
    engine: "engine.mp3",
    hotspot: "hotspot.mp3",
    rolling: "rolling.mp3",
};

// ── Ball ──
export const BALL_RADIUS = 0.35;

// ── Movement ──
export const MAX_SPEED = 7.3; // Free Roam / default
export const ACCEL = 15;
export const DECEL_RATE = 1.5;
// Lower = smoother/slower direction changes while moving. Decoupled from
// ACCEL so turning feels gradual independent of the speed ramp-up curve.
export const TURN_SMOOTHING = 4.5;
// How quickly held input can redirect the ball's horizontal velocity while
// airborne (a full snap-to-target every frame, same as grounded movement,
// is what let pushing a movable prop turn one small unwanted liftoff into
// "flying off" — see playerController.js's _applyInput). Deliberately much
// lower than TURN_SMOOTHING/ACCEL so it reads as "a little air control",
// not full mid-air steering.
export const AIR_CONTROL_RATE = 2.5;
// How far the ball is allowed to drift above the true floor height while
// touching a movable prop before playerController snaps it back down (see
// its update()) — small enough to catch a real climb early, loose enough
// not to fight ordinary resting contact jitter.
export const MOVABLE_PROP_CLIMB_TOLERANCE = 0.03;

// Piecewise speed-fraction curve driven by how long input has been held,
// not by a generic ease. Reaches 100% of MAX_SPEED at exactly 900ms.
export function getAccelFraction(holdMs) {
    if (holdMs <= 800) {
        return lerp(0, 0.50, holdMs / 500);
    } else if (holdMs <= 1000) {
        const t = (holdMs - 500) / (700 - 500);
        return lerp(0.51, 0.70, t);
    } else if (holdMs <= 1100) {
        const t = (holdMs - 700) / (900 - 700);
        return lerp(0.71, 1.0, t);
    }
    return 1.0;
}

function lerp(a, b, t) {
    return a + (b - a) * t;
}

// Inverse of getAccelFraction: given a starting speed as a fraction of
// MAX_SPEED (e.g. currentSpeed / MAX_SPEED), finds the holdMs on the accel
// curve that already produces roughly that fraction. Used so that letting
// go mid-roll and pressing again resumes the ramp from wherever the ball's
// current momentum already sits — 0-0.50 restarts in phase 0, 0.51-0.70
// picks up mid-phase-1, 0.71-1.0 mid-phase-2 — instead of restarting the
// curve (and the ball's velocity) from a dead stop.
export function getStartHoldMs(speedFraction) {
    const frac = Math.min(Math.max(speedFraction, 0), 1);
    if (frac <= 0) return 0;
    // holdMs > 1100 is where getAccelFraction flattens out to exactly
    // 1.0 — using 1100 itself would land on the phase-2 formula's peak,
    // which currently overshoots to 1.29 rather than capping at 1.0.
    if (frac >= 1) return 1101;

    // Binary search since getAccelFraction is monotonic (barring tiny
    // dips right at its phase seams, which this is robust to in practice).
    let lo = 0;
    let hi = 1100;
    for (let i = 0; i < 25; i++) {
        const mid = (lo + hi) / 2;
        if (getAccelFraction(mid) < frac) {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    return (lo + hi) / 2;
}

// ── Slope sliding ──
export const SLIDE_MIN_SLOPE = 0.08;    // radians — below this, treat as "flat" and just decelerate
// Slope-sliding speed cap now just mirrors PlayerController's live
// this.maxSpeed (which changes per game mode) rather than a fixed
// constant — see PlayerController.setMaxSpeed().

// ── Reversal skid ──
// Made deliberately aggressive so skidding is a headline part of the feel:
// triggers on sharper (not just near-180°) direction changes, kicks in at
// much lower speed, and the drift itself is held noticeably longer before
// the new direction takes over. Paired with the camera lean in
// CameraController.
export const REVERSAL_SKID_DURATION = 0.4;   // seconds the skid blend lasts
export const REVERSAL_DOT_THRESHOLD = -0.15; // triggers on sharp turns, not just near-full reversals
export const REVERSAL_MIN_SPEED = 1.2;       // skids can kick in at lower speeds too

// ── Camera / skid feedback ──
export const CAMERA_OFFSET = { x: 4.2, y: 6.5, z: 4.2 };
// export const CAMERA_OFFSET = { x: 16.2, y: 35, z: 16.2 };
export const SKID_CAMERA_ROLL = 0.045;        // radians of camera roll at full skid intensity
export const SKID_CAMERA_ROLL_SMOOTH = 0.08;  // eases the roll in/out instead of snapping

// ── Hotspot camera framing ──
// While a hotspot is active, CameraController eases from the normal follow
// framing into a tighter, wider-FOV shot looking slightly above the ball,
// then eases back out once it clears. Each hotspot node ("Hotspot_N" from
// the level GLB, same names as HOTSPOT_CONTENT in hotspotSystem.js) can have
// its own offset/fov/targetYOffset here. Any hotspot without an entry falls
// back to DEFAULT_HOTSPOT_CAMERA_CONFIG below.
export const HOTSPOT_CAMERA_CONFIGS = {
    Hotspot_1: {
        offset: { x: 2.5, y: 1.0, z: 2.5 }, // tighter than CAMERA_OFFSET
        fov: 55,                             // wider than the base 45° FOV — exaggerates the moment
        targetYOffset: 1.20,                 // meters above the ball the camera looks at
    },
    Hotspot_2: {
        offset: { x: 4.5, y: 1.0, z: 1 },
        fov: 45,
        targetYOffset: 0.95,
    },
    Hotspot_3: {
        offset: { x: 4.5, y: 0.0, z: 6.5 },
        fov: 25,
        targetYOffset: 0.80,
    },
    Hotspot_4: {
        offset: { x: 6.5, y: 0.5, z: 6 },
        fov: 25,
        targetYOffset: 0.9,
    },
    Hotspot_5: {
        offset: { x: 1.5, y: 1.0, z: 6.5 },
        fov: 25,
        targetYOffset: 0.80,
    },
};

// Used for any hotspot (e.g. Hotspot_3/4/5) that doesn't have its own entry
// in HOTSPOT_CAMERA_CONFIGS above — keeps the old shared look as the default.
export const DEFAULT_HOTSPOT_CAMERA_CONFIG = {
    offset: { x: 2.5, y: 1.0, z: 2.5 },
    fov: 55,
    targetYOffset: 0.85,
};

export const HOTSPOT_CAMERA_BLEND = 0.1;       // per-frame ease factor (not dt-scaled), matches SKID_CAMERA_ROLL_SMOOTH's style

// ── Wall bounce overlay ──
export const BOUNCE_DURATION = 0.8; // seconds of smooth transition after a wall impact

// ── Landing bounce sequence ──
export const MAX_LANDING_BOUNCES = 3;

// ── Ground detection ──
export const GROUND_RAY_LENGTH = BALL_RADIUS + 0.15;
// Seconds of airtime required before a landing counts as "real" rather than
// a seam/ramp raycast flicker.
export const MIN_AIRBORNE_TIME = 0.12;

// ── Hotspots ──
// How long player input is locked out after a hotspot fires (e.g. the
// respawn/checkpoint trigger). The ball still obeys physics (gravity,
// slope sliding, wall bounces) during this window — the player just can't
// steer until it elapses.
export const HOTSPOT_STUCK_DURATION = 1.0; // seconds
// How close (meters) the ball's center needs to be to a level-authored
// Hotspot_N marker's position before HotspotSystem treats it as "entered".
export const HOTSPOT_TRIGGER_RADIUS = 0.5;

export const HOTSPOT_ENTER_RADIUS = 0.5;
export const HOTSPOT_EXIT_RADIUS = 0.7; 


// ── Hotspot wobble-to-stop ──
// The moment input locks out, the ball doesn't just glide to a stop — it
// oscillates side-to-side (perpendicular to whatever direction it was
// traveling at that instant) with an offset that decays over the stuck
// window, reading as a "wobble" rather than a flat deceleration. Tuned so
// the decay is essentially zero by HOTSPOT_STUCK_DURATION, so it settles
// right as control returns instead of visibly snapping back to center.
export const HOTSPOT_WOBBLE_AMPLITUDE = 0.08; // meters of max sideways offset — gentle, not a hard shake
export const HOTSPOT_WOBBLE_FREQUENCY = 4;    // oscillations per second — slower, softer rhythm
export const HOTSPOT_WOBBLE_DECAY = 5;        // higher = settles faster

// ── Dev-tool hotspot teleport ──
// Pressing "1".."5" teleports the ball near (not directly onto) the
// matching Hotspot_N marker — see devTools.js. Off by default; the
// dev-tool checkbox toggles it at runtime. Diagonal offset (dx == dz) so
// the landing spot sits just outside the hotspot's own enter/exit trigger
// radius instead of immediately re-triggering its popup.
export const TELEPORT_HOTSPOT_OFFSET = 2; // meters from the hotspot marker
// Vertical lift above the marker's authored position, same idea as
// RespawnSystem's own +0.3 spawn lift, sized up a bit since teleports can
// land on uneven ground the ball wasn't already resting on.
export const TELEPORT_LIFT = BALL_RADIUS + 0.5;

// ── Respawn ──
// Seconds "behind" the ball's live grounded position that the respawn
// anchor tracks, so a fast run off a ledge lands you further back than a
// slow creep off the same edge.
export const RESPAWN_ANCHOR_DELAY = 0.4;
// World units below the level's lowest collision mesh before we call it
// "fell off".
export const FALL_MARGIN = 5;

// ── Fall fade-to-black ──
export const FADE_TRIGGER_MARGIN = 30; // meters above the fall threshold
export const FADE_OUT_DURATION = 0.6;  // seconds clear -> black
export const FADE_IN_DURATION = 0.6;   // seconds black -> clear after respawn

// ── Audio volumes ──
export const ENGINE_MIN_GAIN = 0.05; // faint idle noise as soon as the player inputs
export const ENGINE_MAX_GAIN = 0.35; // full volume at max speed
export const ENGINE_SMOOTH = 1.8;    // ramp speed from faint -> full
export const ROLLING_MAX_GAIN = 0.5;
export const ROLLING_MOVE_THRESHOLD = 0.05; // m/s below which the ball counts as stopped
export const AUDIO_SMOOTH = 6;              // rolling gain transition speed

// ── World collision-mesh material ──
// Matte with just a hint of shine: high roughness keeps highlights soft and
// diffuse, metalness stays at 0 so it doesn't read as metal, and a thin,
// rough clearcoat adds a faint sheen without looking lacquered/glossy.
export const WORLD_ROUGHNESS = 0.75;
export const WORLD_METALNESS = 0;
export const WORLD_CLEARCOAT = 0.15;
export const WORLD_CLEARCOAT_ROUGHNESS = 0.45;
export const GLOW_COLOR = 0x33ccff;
// Neon-red variant swapped in for GlowPath/EndTrigger while a Collection
// Time Trial run is short on orbs (see GameModeManager._updateGlowColor) —
// reverts to GLOW_COLOR once all TIME_TRIAL_ORB_COUNT orbs are collected.
export const GLOW_COLOR_ALERT = 0xff2a3d;
export const BLOOM_LAYER = 1;

// ── Player entrance (spawn beam) ──
// Plays once per page load, right after the level + ball have both
// finished loading (see LoadingScreen/PlayerEntrance in main.js): a
// cylindrical beam of light drops onto the spawn point, the player pops in
// at its base, then the beam retracts and disappears. The ball is hidden
// and the player frozen (see PlayerController.setFrozen) for the entire
// sequence so nothing is visible/movable before it fires.
export const ENTRANCE_BEAM_RADIUS = 1;   // meters
export const ENTRANCE_BEAM_HEIGHT = 30;  // meters
export const ENTRANCE_BEAM_COLOR = 0xaeefff;
// Durations sum to ~1.25s of beam motion; the hold in the middle is what
// the player actually spawns during — see PlayerEntrance._onBeamReachedFloor.
export const ENTRANCE_DESCEND_DURATION = 0.4;  // beam grows down to the floor
export const ENTRANCE_HOLD_DURATION = 0.45;    // full beam, player visible
export const ENTRANCE_RETRACT_DURATION = 0.4;  // beam shrinks back up and vanishes
// Ground flash ring, triggered the instant the beam touches down.
export const ENTRANCE_RING_DURATION = 0.5;
export const ENTRANCE_RING_MAX_SCALE = 2.6;

// ── Hotspot environment grayscale ──
// Camera layer flagged onto every ball mesh (main model + fallback sphere).
// BloomRenderer renders a mask pass using only this layer so it knows which
// screen pixels belong to the ball and should stay in full color while the
// rest of the frame desaturates.
export const BALL_COLOR_LAYER = 2;
// Per-frame ease factor (not dt-scaled, same style as HOTSPOT_CAMERA_BLEND)
// used to smoothly blend the environment between full color and full
// grayscale as hotspots activate/deactivate.
export const HOTSPOT_GRAYSCALE_BLEND = 0.06;

// ── Ball speed-glow (bloom) ──
// Reuses the same 500/700/900ms accel curve that drives movement speed
// (getAccelFraction above), applied to the ball's glow-material
// emissiveIntensity instead of velocity. ball_light glows brighter than
// inner_ball at full ramp.
export const BALL_GLOW_INNER_MAX = 2.0; // inner_ball emissiveIntensity ceiling
export const BALL_GLOW_LIGHT_MAX = 3.6; // ball_light emissiveIntensity ceiling — brighter than inner_ball

// ── Player-relative depth fog ──
// Tracks the ball's height rather than a fixed level marker: anything more
// than FOG_START_DEPTH below the player starts to haze over, ramping to
// fully opaque by FOG_FULL_DEPTH below. Depth test stays on, so solid
// ground still occludes it normally — it only becomes visible when there's
// actually open space (a pit, a gap) beneath the player for it to fill.
export const FOG_START_DEPTH = 5;     // meters below the player where haze begins
export const FOG_FULL_DEPTH = 20;     // meters below the player where it's fully opaque
export const FOG_LAYER_COUNT = 16;    // more layers = smoother gradient, at some fill-rate cost
export const FOG_TOP_OPACITY = 0.05;  // barely-there haze at the start-depth end
// Capped below 1 so even the deepest fog layer stays slightly see-through —
// otherwise the bottom layer paints a flat, fully opaque wall that hides
// the sky dome's golden horizon color entirely instead of hazing over it.
export const FOG_MAX_OPACITY = 0.82;
export const FOG_FALLOFF_POWER = 2.2; // >1 keeps the top thin and piles density on fast near the bottom
// Light sky-blue tint (matching the sky's horizon/glow colors in sky.js)
// instead of a neutral grey, so wherever the fog does overlap the sky it
// reads as a natural continuation/haze rather than a mismatched wall.
export const FOG_COLOR = 0xaed7f2;
export const FOG_PLANE_SIZE = 500;    // wide enough that its edges are never visible on screen

// When false (default), the fog band is anchored once at load — 5m below
// the player's spawn position — and stays there for the rest of the round.
// When true, the whole band continuously follows the player's current
// height instead.
export const isFogFollowPlayer = false;

// ── Game modes ──
export const GAME_MODE_FREE_ROAM = "freeroam";
export const GAME_MODE_SPEEDRUN = "speedrun";
export const GAME_MODE_TIME_TRIAL = "timetrial";

// ── Per-mode max speed ──
export const MAX_SPEED_SPEEDRUN = 10.7;
export const MAX_SPEED_TIME_TRIAL = 8.6;
// Looked up by GameModeManager.selectMode() to push the right cap into
// PlayerController/AudioManager whenever the player picks a mode.
export const MAX_SPEED_BY_MODE = {
    [GAME_MODE_FREE_ROAM]: MAX_SPEED,
    [GAME_MODE_SPEEDRUN]: MAX_SPEED_SPEEDRUN,
    [GAME_MODE_TIME_TRIAL]: MAX_SPEED_TIME_TRIAL,
};

// The one hotspot that stays interactable (it doubles as the mode-select
// menu) while Speedrun/Time Trial hide every other hotspot for the
// duration of the run.
export const HOTSPOT_1_NAME = "Hotspot_1";

export const TIME_TRIAL_DURATION = 140; // seconds on the Time Trial countdown
export const TIME_TRIAL_ORB_COUNT = 27; // orbs randomly picked from "Collectables" each run
export const ORB_COLOR = 0xffcc33;
export const ORB_MIN_RADIUS = 0.15; // floor so a tiny/degenerate Sphere marker still reads as a pickup

// Padding (world units) added on top of the ball's own radius when
// building the StartTrigger/EndTrigger bounding boxes, so a fast-moving
// ball reliably registers the trigger instead of possibly skipping past it
// between two physics steps.
export const TRIGGER_EXPAND = 0.05;

// ── EndTrigger pulsating-ring + finish-column effect ──
export const END_RING_COUNT = 3;
// Gap (meters) between the EndTrigger's own edge and the first ring, and
// between each subsequent ring — so the resting/spawn arrangement is
// object -> +0.15 -> +0.15 -> +0.15.
export const END_RING_GAP = 0.15;
// Seconds for one ring to shrink from its outer spawn radius all the way
// to the center (and fade out) before a fresh one spawns at the edge.
export const END_RING_CYCLE_DURATION = 2.2;
// Ring thickness as a fraction of its current radius — keeps the ring
// reading as a consistent line rather than a filled disc as it shrinks.
export const END_RING_THICKNESS_RATIO = 0.12;
export const END_RING_BASE_OPACITY = 0.85;
// Tall neon "finish column" wall standing on the EndTrigger's footprint.
// Kept dimmer/more transparent than the core + rings on purpose, so the
// wall reads as a faint boundary marker rather than competing with the
// pulsating-ring effect for attention. Its emissive intensity is set just
// above BloomRenderer's UnrealBloomPass threshold (1.0) so it picks up a
// slight bloom glow without overpowering the core/rings.
export const END_WALL_HEIGHT = 80;
export const END_WALL_OPACITY = 0.1;
export const END_WALL_EMISSIVE_INTENSITY = 1.1;

// ── Movable objects (pushable props + per-section reset trigger) ──
// Level-authored group names: any number of "MovableObjectSection"-prefixed
// nodes can exist (matched by prefix, not exact equality — Blender's GLTF
// exporter auto-suffixes duplicate object names with ".001", ".002", etc,
// and the level author may also use an explicit "_1"/"_2" convention; a
// strict equality check would silently miss every section after the
// first). Each section contains a "MovableObjects" group (the actual
// gravity-affected, ball-pushable Cube/Sphere meshes) and a sibling
// "MovableObjectResetTrigger" cylinder marker. Rolling onto a section's own
// trigger pops up a "reset?" confirmation that only snaps THAT section's
// objects back to their authored positions — see movableObjectSystem.js.
//
// The INNER names need prefix matching too, for a subtler reason than the
// section names: three.js's GLTFLoader calls parser.createUniqueName() on
// every node in the file, which auto-suffixes ANY name it's already seen
// elsewhere in the document with "_1", "_2", etc. — regardless of nesting.
// Since both sections' "MovableObjects"/"MovableObjectResetTrigger" groups
// share identical names, the loader silently renames the second section's
// copies to "MovableObjects_1"/"MovableObjectResetTrigger_1" at load time,
// even though the source .glb has them both named identically. Confirmed
// by actually loading this project's GLB through GLTFLoader and inspecting
// the parsed scene graph.
export const MOVABLE_SECTION_PATTERN = /^MovableObjectSection/i;
export const MOVABLE_OBJECTS_GROUP_PATTERN = /^MovableObjects/i;
export const MOVABLE_RESET_TRIGGER_PATTERN = /^MovableObjectResetTrigger/i;

// Cannon-es collision-filter bit for movable-prop bodies. Physical
// collision (pushing, resting, etc.) is untouched by this — it only comes
// into play where something explicitly passes a collisionFilterMask, which
// today is exactly one place: playerController.js's ground-detection
// raycast. That ray used to hit everything (mask -1), including movable
// props — and since props are now roughly ball-sized (see
// MOVABLE_MIN_RADIUS_FACTOR) for pushability, the ball's downward ray would
// often land on the curved top of a nearby prop and read it as ground,
// which fed straight into the same slope-following code real ramps use —
// so the ball would climb up onto a prop it was trying to push instead of
// pushing it. Giving props their own bit and having that one raycast
// explicitly exclude it stops the ray from ever "seeing" a prop as ground,
// while everything else about them (physical collision, being pushed,
// resting on the real floor) works exactly as before.
export const MOVABLE_COLLISION_GROUP = 2;

// Physics tuning for the pushable props. Kept light and low-friction/
// low-damping relative to the ball so a push actually carries them — the
// ball's own movement is driven by directly setting ballBody.velocity every
// frame (see playerController.js's _applyInput/_applyDeceleration), not by
// applying forces/impulses, so the ball itself barely slows down when it
// hits a prop; how "hard to move" a prop feels comes down entirely to ITS
// friction/damping/mass eating the momentum transferred on contact, not the
// ball's mass at all. Verified with a direct push-distance test: this
// tuning moves a prop ~2.6x farther in the same push time than an earlier,
// heavier-feeling pass.
export const MOVABLE_MASS = 0.1;              // lighter — was 0.15, easier for a push to get moving
export const MOVABLE_LINEAR_DAMPING = 0.08;   // slightly higher than before so the extra restitution below settles into a bouncy wobble instead of sliding on
export const MOVABLE_ANGULAR_DAMPING = 0.3;
export const MOVABLE_FRICTION = 0.15;         // vs. floor/wall/each other
export const MOVABLE_BALL_FRICTION = 0.25;    // vs. the ball specifically — was 0.35; lowered so a push doesn't feel "sticky" on a light object
export const MOVABLE_RESTITUTION = 0.15;      // vs. floor/wall/each other — a touch more than before, still settles
export const MOVABLE_BALL_RESTITUTION = 0.35; // vs. the ball specifically — was 0.2; noticeably livelier "light and bouncy" pop on contact

// Safety clamp applied after every physics step: a tightly packed stack of
// many touching props (e.g. a block tower) is a worst case for an
// iterative solver, and a single under-converged step can otherwise inject
// enough corrective velocity into one prop to tunnel through geometry
// before the next step's collision check ever sees it. Clamping is cheap
// insurance against that regardless of how well-tuned the contact
// materials are.
export const MOVABLE_MAX_LINEAR_SPEED = 12;
export const MOVABLE_MAX_ANGULAR_SPEED = 20;

// How quickly a prop is allowed to fall back asleep once it's basically
// stopped. This matters a lot more than it sounds like it should: a
// disturbed prop isn't expensive because of the solver — profiling showed
// the solver costs under 1ms even with dozens of props awake. The real
// cost is narrowphase: every AWAKE prop repeatedly tests against every
// nearby piece of the level's real Floor/Walls (many small Trimesh pieces —
// see physicsWorld.js's addTrimeshCollider), and cannon-es's sphere-vs-
// trimesh check is a brute-force per-triangle scan with no internal spatial
// acceleration (confirmed directly: merging those pieces into fewer, larger
// meshes made this WORSE, not better, since each test then had to scan even
// more triangles). So the real lever is keeping as few props awake, for as
// short a time, as possible — not making each awake step cheaper. Cannon-es
// defaults (sleepSpeedLimit 0.1, sleepTimeLimit 1s) let a settling prop
// jitter around "awake" for a full second after a push. Measured directly
// against this level: default settings held a disturbed 64-cube stack in
// the expensive state for ~2s with a 28ms peak frame; these tighter values
// cut the peak to ~14ms and the sustained cost by roughly 70%, with no
// measurable effect on how far a prop travels under an active push (it only
// changes how fast it re-sleeps once nothing is pushing it anymore).
export const MOVABLE_SLEEP_SPEED_LIMIT = 0.3;
export const MOVABLE_SLEEP_TIME_LIMIT = 0.1;

// The "did this prop actually land, or did it just go to sleep mid-air"
// watchdog (see MovableObjectSystem._verifyGroundedOnSleep). Tolerance is
// deliberately generous — bigger than the small intentional hover already
// described above for undersized props (MOVABLE_MIN_RADIUS_FACTOR) — so
// normal, correctly-resting props are never falsely flagged and re-woken;
// it only catches props sleeping well above anything that could plausibly
// be holding them up. Nudge is a one-time extra downward velocity (on top
// of whatever gravity already gave it) so a re-woken prop visibly starts
// falling again immediately rather than just barely creeping.
export const MOVABLE_GROUND_CHECK_TOLERANCE = 0.15; // meters
export const MOVABLE_GROUND_CHECK_MAX_RETRIES = 6; // per prop, before giving up rather than risk an infinite wake loop
export const MOVABLE_GROUND_CHECK_NUDGE = 0.5; // m/s

// How many sleeping props the round-robin watchdog sweep re-verifies per
// frame (see MovableObjectSystem._sweepGroundWatchdog). Deliberately a
// small flat number rather than "all of them" — cost per frame stays
// constant no matter how many props the level has, and even a large prop
// count only takes a few seconds to cycle through entirely at 60+fps.
export const MOVABLE_WATCHDOG_CHECKS_PER_FRAME = 3;

// Every prop — including the "Cube" ones — gets a CANNON.Sphere collider,
// not a Box. This isn't a style choice: I verified it directly (drop a Box
// AND a ConvexPolyhedron built from that same box onto a static Trimesh in
// isolation — both fall straight through with zero contacts ever
// generated, while a Sphere settles correctly). cannon-es's Narrowphase
// only ever implements sphere-vs-trimesh and plane-vs-trimesh; box-vs-
// trimesh and convex-vs-trimesh are dead code paths in this library
// version. Since this level's Floor/Walls group (physicsWorld.js's
// addTrimeshCollider) IS a CANNON.Trimesh, a Box-shaped prop can never
// collide with it — full stop, not a tuning problem, and not fixable
// without either changing the Floor/Walls representation itself or adding
// separate proxy collision geometry (both of which are off the table).
//
// The sphere is also given `fixedRotation: true` (see
// _createMovableObject), so despite being a sphere under the hood it
// SLIDES along the floor rather than rolling/tumbling like a ball — no
// wasted momentum spinning it up, and no rolling-away-in-a-random-direction
// behavior a real box wouldn't have either. That's the closest this engine
// can get to "acts like a pushable box" while still using a shape that
// actually touches the real floor.
//
// Using an INSCRIBED sphere (radius = the geometry's smallest half-extent,
// not the circumscribed bounding sphere) keeps a resting cube's visual
// bottom face flush with the real floor instead of floating or sinking —
// but ALSO empirically caused "hard to push": I tested a range of prop
// radii against the ball's own (0.35) radius, ball speed held constant,
// and there's a sharp cutoff right around matching the ball's radius —
// below it the ball just rides up and over the smaller sphere (their
// centers are far enough apart in height that the contact normal points
// mostly upward, not sideways) and barely nudges it; at/above it, the push
// works properly. So the radius is floored at BALL_RADIUS * this factor —
// small props (this level has several at half the ball's size) end up
// hovering slightly above the true floor as a result. That's a real,
// visible trade-off for making them reliably pushable; lower this factor
// (and accept weaker pushing on the smallest props) if the hover reads
// wrong once you see it in place.
export const MOVABLE_MIN_RADIUS_FACTOR = 1.0; // multiplied by BALL_RADIUS to get the floor on prop collision radius
export const MOVABLE_RADIUS_SHRINK = 1.0; // multiplier on the inscribed radius before the BALL_RADIUS floor above is applied


// Meters directly above a MovableObjectResetTrigger's authored position
// that its "reset?" confirmation popup is anchored.
export const MOVABLE_RESET_POPUP_HEIGHT = 1;

// Reset-trigger marker glow — amber rather than GLOW_COLOR's blue, so it
// reads as a distinct "utility" marker rather than another neon-path
// hotspot (same emissive/bloom material trick as HotspotSystem._setupGlow).
export const MOVABLE_RESET_GLOW_COLOR = 0xffaa33;

// ── Route-based page-navigation triggers ──
// Level-authored "RouteBasedTriggers" group, read via a plain
// root.getObjectByName() in levelLoader (same convention as "Hotspots"/
// "GlowPath" — there's only ever one of these, so unlike
// MovableObjectSection there's no need for prefix/duplicate-name
// matching). Each direct child is a small marker (same authoring style as
// MovableObjectResetTrigger) that, once rolled onto, shows a camera-facing
// "Press Enter for <label>" 3D billboard (see routeTriggerBillboard.js) and
// — if the player presses Enter while still standing on it — navigates the
// whole page to `url`. Add an entry here for every new trigger node
// authored under "RouteBasedTriggers" in the level GLB.
export const ROUTE_TRIGGERS_ROOT_NAME = "RouteBasedTriggers";
export const ROUTE_TRIGGER_CONTENT = {
    ToAboutPageTrigger: {
        label: "AboutPage",
        // Resolved against the CURRENT page's URL at navigation time
        // (rather than a baked-in absolute path) so this keeps working
        // whether the game is served from "http://localhost:5050/",
        // a real domain, or a sub-path. Targets "about" (no extension) —
        // the dev server serves the about page at that clean route rather
        // than at "about.html" directly.
        url: () => new URL("about", window.location.href).href,
    },
    ToGithub: {
        label: "My Github",
        url: "https://github.com/Dreigannadoit",
    },
    ToLinkedIn: {
        label: "My Linkedin",
        url: "https://www.linkedin.com/in/dreiabmab1/",
    },
};

// Route-trigger marker glow — yellow, same emissive/bloom material trick as
// GlowPath/HotspotSystem/MovableObjectResetTrigger's markers, just its own
// color so route triggers read as their own distinct marker type. A touch
// more gold than pure yellow (0xffe600) specifically so it doesn't sit at
// near-maximal R+G — BloomRenderer composites bloom as a flat, unclamped
// additive add (see its mixPass), so a near-white source blows out far
// harder than an amber/blue one at the identical emissiveIntensity.
export const ROUTE_TRIGGER_GLOW_COLOR = 0xf2c200;

// Route triggers pulse MUCH dimmer than GlowPath/HotspotSystem/
// MovableObjectResetTrigger's shared 2.2-3.4 "core" range — those markers
// don't have anything reading text floating right above them, but the
// route-trigger billboard sits close enough to its own marker that the
// bloom halo would otherwise wash out the "Press Enter for ..." text.
// Kept just above BloomRenderer's UnrealBloomPass threshold (1.0) so the
// marker still visibly glows, just faintly — same idea as
// END_WALL_EMISSIVE_INTENSITY.
export const ROUTE_TRIGGER_GLOW_MIN_INTENSITY = 1.05;
export const ROUTE_TRIGGER_GLOW_MAX_INTENSITY = 1.45;

// Meters directly above a route trigger's authored position that its
// "Press Enter for ..." billboard is anchored — a bit higher than
// MOVABLE_RESET_POPUP_HEIGHT's 1m specifically to put more distance
// between the panel and the bloom halo below it.
export const ROUTE_TRIGGER_POPUP_HEIGHT = 1.5;

// Extra meters added to a trigger's own footprint radius (+ BALL_RADIUS)
// once it's active, before it's considered "left" — the same
// enter-radius/exit-radius hysteresis gap HotspotSystem uses
// (HOTSPOT_ENTER_RADIUS/HOTSPOT_EXIT_RADIUS), just expressed as a delta
// here since each route trigger's own enter radius is computed from its
// authored geometry rather than being one shared constant.
export const ROUTE_TRIGGER_EXIT_BUFFER = 0.25;