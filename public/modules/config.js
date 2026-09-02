// ── Asset locations ──
export const ASSET_BASE = "/assets/";
export const GLB_URL = ASSET_BASE + "maze_platform_high.glb";
export const BALL_GLB_URL = ASSET_BASE + "ball.glb";

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

export const TIME_TRIAL_DURATION = 150; // seconds on the Time Trial countdown
export const TIME_TRIAL_ORB_COUNT = 20; // orbs randomly picked from "Collectables" each run
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