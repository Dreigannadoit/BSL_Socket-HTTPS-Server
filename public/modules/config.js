// ── Asset locations ──
export const ASSET_BASE = "http://localhost:8081/assets/";
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
export const MAX_SPEED = 6.3;
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

// ── Slope sliding ──
export const SLIDE_MIN_SLOPE = 0.08;    // radians — below this, treat as "flat" and just decelerate
export const SLIDE_MAX_SPEED = MAX_SPEED; // cap for how fast sliding can get

// ── Reversal skid ──
// Made deliberately aggressive so skidding is a headline part of the feel:
// triggers on sharper (not just near-180°) direction changes, kicks in at
// much lower speed, and the drift itself is held noticeably longer before
// the new direction takes over. Paired with the camera lean in
// CameraController.
export const REVERSAL_SKID_DURATION = 1.4;   // seconds the skid blend lasts
export const REVERSAL_DOT_THRESHOLD = -0.15; // triggers on sharp turns, not just near-full reversals
export const REVERSAL_MIN_SPEED = 1.2;       // skids can kick in at lower speeds too

// ── Camera / skid feedback ──
export const CAMERA_OFFSET = { x: 4.2, y: 6.5, z: 4.2 };
export const SKID_CAMERA_ROLL = 0.045;        // radians of camera roll at full skid intensity
export const SKID_CAMERA_ROLL_SMOOTH = 0.08;  // eases the roll in/out instead of snapping

// ── Wall bounce overlay ──
export const BOUNCE_DURATION = 0.3; // seconds of smooth transition after a wall impact

// ── Landing bounce sequence ──
export const MAX_LANDING_BOUNCES = 3;

// ── Ground detection ──
export const GROUND_RAY_LENGTH = BALL_RADIUS + 0.15;
// Seconds of airtime required before a landing counts as "real" rather than
// a seam/ramp raycast flicker.
export const MIN_AIRBORNE_TIME = 0.12;

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

// ── Neon glow path ──
export const GLOW_COLOR = 0x33ccff;
export const BLOOM_LAYER = 1;

// ── Height-based fog ──
export const FOG_LAYER_COUNT = 14;    // more layers = smoother gradient, at some fill-rate cost
export const FOG_TOP_OPACITY = 0.05;  // barely-there haze at the top of the volume
export const FOG_FALLOFF_POWER = 2.2; // >1 keeps the top thin and piles density on fast near the bottom
export const FOG_COLOR = 0xdfe6ea;
