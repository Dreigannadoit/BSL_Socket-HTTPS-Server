import { fetchAssetBlobURL } from "./binaryAssetLoader.js";
import {
    resolveAssetUrl,
    BG_MUSIC_FILES,
    BG_MUSIC_VOLUME,
    BG_MUSIC_DUCK_LEVEL,
    BG_MUSIC_DUCK_FADE,
} from "./config.js";

// Looping background music, independent of AudioManager's engine/rolling/
// one-shot SFX layer.
//
// Home page (game.js -> startGame({ bgMusicTrack: "home" })): home.mp3
// plays by default. GameModeManager calls crossfadeTo("rush", ...) the
// instant a Speedrun/Time Trial run begins (StartTrigger) and
// crossfadeTo("home", ...) once it ends (EndTrigger) — see gameModeManager.js.
//
// About page (about.js -> startGame({ bgMusicTrack: "about" })): about.mp3
// plays throughout; nothing ever crossfades it.
//
// Independently of any crossfade, setDucked(true/false) is called by
// hotspotSystem.js whenever an H2-H5 Record_player narration clip starts/
// stops, turning the whole thing down so the narration stays audible.
//
// setMuted()/toggleMuted() (see musicToggleUI.js's top-right button) is a
// third, independent knob layered on top of both of the above — it only
// ever silences THIS manager's tracks, never AudioManager's engine/
// rolling/bounce/hotspot SFX or a hotspot's H2-H5 narration clip.
export class BackgroundMusicManager {
    constructor(initialTrack) {
        this._audioByTrack = {};   // name -> <audio>, created lazily and kept forever once made
        this._loading = {};        // name -> in-flight blob-URL promise (so overlapping calls share one fetch)
        this._activeTrack = null;
        this._activeAudio = null;
        this._duckFactor = 1;      // 1 = full volume, BG_MUSIC_DUCK_LEVEL = ducked
        this._muted = false;       // user-toggled, independent of ducking/crossfades
        this._fadeToken = 0;       // bumped on every crossfade so a superseded rAF loop stops early
        this._duckToken = 0;       // same idea, for the duck tween

        // Browsers block audio until a user gesture — same unlock pattern
        // AudioManager uses for its own AudioContext.
        this._unlock = this._unlock.bind(this);
        window.addEventListener("keydown", this._unlock);
        window.addEventListener("pointerdown", this._unlock);

        if (initialTrack) this._playImmediate(initialTrack);
    }

    _unlock() {
        if (this._activeAudio && this._activeAudio.paused) {
            this._activeAudio.play().catch(() => {});
        }
        window.removeEventListener("keydown", this._unlock);
        window.removeEventListener("pointerdown", this._unlock);
    }

    // Fetches + decodes a track's blob URL the first time it's needed, and
    // caches the resulting <audio> element (and its blob URL) for reuse —
    // so switching back and forth (e.g. several runs in one session) never
    // re-downloads a clip it's already played.
    async _getAudio(name) {
        if (this._audioByTrack[name]) return this._audioByTrack[name];
        if (!this._loading[name]) {
            const file = BG_MUSIC_FILES[name];
            this._loading[name] = fetchAssetBlobURL(resolveAssetUrl(file), "audio/mpeg")
                .then((blobUrl) => {
                    const audio = new Audio(blobUrl);
                    audio.loop = true;
                    audio._rawVolume = 0; // last volume set before duck/mute were applied
                    audio.volume = 0;
                    this._audioByTrack[name] = audio;
                    return audio;
                })
                .catch((err) => {
                    console.error(`Failed to load background music "${name}":`, err);
                    delete this._loading[name];
                    throw err;
                });
        }
        return this._loading[name];
    }

    // Single point where raw (pre-duck, pre-mute) volume becomes the
    // audio element's actual .volume — every fade/duck step and the mute
    // toggle all funnel through here so they can never disagree.
    _applyVolume(audio) {
        const vol = this._muted ? 0 : audio._rawVolume * this._duckFactor;
        audio.volume = Math.max(0, Math.min(1, vol));
    }

    _setRawVolume(audio, raw) {
        audio._rawVolume = raw;
        this._applyVolume(audio);
    }

    // Starts a track immediately at full (post-duck/mute) volume, no fade —
    // used once at boot for whichever track the current page opens on.
    async _playImmediate(name) {
        const audio = await this._getAudio(name);
        this._activeTrack = name;
        this._activeAudio = audio;
        this._setRawVolume(audio, BG_MUSIC_VOLUME);
        audio.play().catch(() => {
            // Autoplay blocked until the first gesture — _unlock() above
            // retries as soon as the player clicks/presses anything.
        });
    }

    // Crossfades from whatever's currently active to `name` over
    // `durationSec`: the outgoing track ramps 1 -> 0 and the incoming
    // track (started from 0) ramps 0 -> 1 over that same span, so a
    // "fast" vs "slow" transition is just a shorter or longer duration —
    // see gameModeManager.js's BG_MUSIC_FAST_FADE/BG_MUSIC_SLOW_FADE calls.
    // No-op if `name` is already the active track.
    async crossfadeTo(name, durationSec) {
        if (this._activeTrack === name) return;

        const outgoing = this._activeAudio;
        const incoming = await this._getAudio(name);
        // Something else may have already switched tracks again while the
        // fetch above was in flight — don't stomp on it.
        if (this._activeTrack === name) return;

        this._activeTrack = name;
        this._activeAudio = incoming;

        incoming.currentTime = 0;
        this._setRawVolume(incoming, 0);
        incoming.play().catch(() => {});

        const token = ++this._fadeToken;
        const startTime = performance.now();
        const fromVol = outgoing ? outgoing._rawVolume : 0;

        const step = (now) => {
            if (token !== this._fadeToken) return; // a newer crossfade took over
            const t = Math.min(1, (now - startTime) / (durationSec * 1000));
            if (outgoing) this._setRawVolume(outgoing, fromVol * (1 - t));
            this._setRawVolume(incoming, BG_MUSIC_VOLUME * t);
            if (t < 1) {
                requestAnimationFrame(step);
            } else if (outgoing) {
                outgoing.pause();
            }
        };
        requestAnimationFrame(step);
    }

    // Ducks (isDucked = true) or restores (false) the whole background
    // music mix — used while an H2-H5 narration clip is playing so it
    // reads clearly over the music. Smoothed over BG_MUSIC_DUCK_FADE
    // rather than snapped, and re-applied every frame to whichever
    // track(s) currently have volume > 0 (so it stays correct even mid-
    // crossfade). No-op if already at the requested level.
    setDucked(isDucked) {
        const target = isDucked ? BG_MUSIC_DUCK_LEVEL : 1;
        if (Math.abs(this._duckFactor - target) < 0.001) return;

        const token = ++this._duckToken;
        const start = this._duckFactor;
        const startTime = performance.now();

        const step = (now) => {
            if (token !== this._duckToken) return; // superseded by another setDucked() call
            const t = Math.min(1, (now - startTime) / (BG_MUSIC_DUCK_FADE * 1000));
            this._duckFactor = start + (target - start) * t;
            for (const audio of Object.values(this._audioByTrack)) {
                this._applyVolume(audio);
            }
            if (t < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
    }

    // User-facing on/off toggle (musicToggleUI.js's top-right button).
    // Snaps immediately rather than fading — this is a deliberate "off"
    // switch, not a mix adjustment — and only ever affects THIS manager's
    // tracks: engine/rolling/bounce/hotspot SFX (AudioManager) and H2-H5
    // narration clips (hotspotSystem.js) are untouched.
    setMuted(muted) {
        this._muted = muted;
        for (const audio of Object.values(this._audioByTrack)) {
            this._applyVolume(audio);
        }
    }

    toggleMuted() {
        this.setMuted(!this._muted);
        return this._muted;
    }

    isMuted() {
        return this._muted;
    }
}
