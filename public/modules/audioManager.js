import * as THREE from "three";
import {
    ASSET_BASE,
    SOUND_FILES,
    MAX_SPEED,
    ENGINE_MIN_GAIN,
    ENGINE_MAX_GAIN,
    ENGINE_SMOOTH,
    ROLLING_MAX_GAIN,
    ROLLING_MOVE_THRESHOLD,
    AUDIO_SMOOTH,
} from "./config.js";

const BOUNCE_NAMES = ["bounce1", "bounce2", "bounce3", "bounce4", "bounce5"];

export class AudioManager {
    constructor() {
        this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        this.masterGain = this.audioCtx.createGain();
        this.masterGain.gain.value = 1.0;
        this.masterGain.connect(this.audioCtx.destination);

        this.soundBuffers = {}; // name -> decoded AudioBuffer
        this.engineGain = null;
        this.rollingGain = null;

        // Current mode's speed cap, used to normalize speed into a 0-1
        // ratio for engine/rolling gain below. Defaults to Free Roam's
        // MAX_SPEED and is kept in sync with PlayerController's own cap by
        // GameModeManager.selectMode() via setMaxSpeed() — otherwise a
        // faster mode like Speedrun would hit "full engine volume" long
        // before actually reaching its higher top speed.
        this.maxSpeed = MAX_SPEED;

        // Browsers block audio until a user gesture — unlock on first input.
        this._unlockAudio = this._unlockAudio.bind(this);
        window.addEventListener("keydown", this._unlockAudio);
        window.addEventListener("pointerdown", this._unlockAudio);

        this.ready = this._loadAll().then(() => {
            this.engineGain = this._startLoopingSound("engine");
            this.rollingGain = this._startLoopingSound("rolling");
        }).catch((err) => console.error("Failed to load audio assets:", err));
    }

    _unlockAudio() {
        if (this.audioCtx.state === "suspended") this.audioCtx.resume();
        window.removeEventListener("keydown", this._unlockAudio);
        window.removeEventListener("pointerdown", this._unlockAudio);
    }

    async _loadSound(name, file) {
        const res = await fetch(ASSET_BASE + file);
        const arrayBuffer = await res.arrayBuffer();
        this.soundBuffers[name] = await this.audioCtx.decodeAudioData(arrayBuffer);
    }

    _loadAll() {
        return Promise.all(
            Object.entries(SOUND_FILES).map(([name, file]) => this._loadSound(name, file))
        );
    }

    _startLoopingSound(name) {
        const buffer = this.soundBuffers[name];
        if (!buffer) return null;
        const source = this.audioCtx.createBufferSource();
        source.buffer = buffer;
        source.loop = true;
        const gain = this.audioCtx.createGain();
        gain.gain.value = 0;
        source.connect(gain).connect(this.masterGain);
        source.start();
        return gain;
    }

    _playOneShot(name, volume = 1) {
        const buffer = this.soundBuffers[name];
        if (!buffer) return; // assets may still be loading — skip rather than queue
        const source = this.audioCtx.createBufferSource();
        source.buffer = buffer;
        const gain = this.audioCtx.createGain();
        gain.gain.value = volume;
        source.connect(gain).connect(this.masterGain);
        source.start();
    }

    // Picks randomly from bounce1–bounce5.
    playBounceSound(volume = 1) {
        const name = BOUNCE_NAMES[Math.floor(Math.random() * BOUNCE_NAMES.length)];
        this._playOneShot(name, volume);
    }

    playHotspotSound(volume = 1) {
        this._playOneShot("hotspot", volume);
    }

    // Called by GameModeManager.selectMode() alongside
    // PlayerController.setMaxSpeed() so engine/rolling volume ramps stay
    // matched to whichever mode's top speed is currently active.
    setMaxSpeed(maxSpeed) {
        this.maxSpeed = maxSpeed;
    }

    // Smoothly blends the looping engine/rolling gains each frame based on
    // ball speed and whether the player is actively steering.
    update(dt, ballBody, keys) {
        const speed = Math.hypot(ballBody.velocity.x, ballBody.velocity.z);
        const speedRatio = THREE.MathUtils.clamp(speed / this.maxSpeed, 0, 1);
        const isControlling = keys.forward || keys.back || keys.left || keys.right;

        // Engine: only while the player is actively steering, faint -> loud
        // with speed.
        if (this.engineGain) {
            const targetGain = isControlling
                ? ENGINE_MIN_GAIN + (ENGINE_MAX_GAIN - ENGINE_MIN_GAIN) * speedRatio
                : 0;
            const engineEase = 1 - Math.exp(-ENGINE_SMOOTH * dt);
            this.engineGain.gain.value += (targetGain - this.engineGain.gain.value) * engineEase;
        }

        // Rolling: plays whenever the ball is actually moving, controlled
        // or not.
        if (this.rollingGain) {
            const targetGain = speed > ROLLING_MOVE_THRESHOLD ? ROLLING_MAX_GAIN * speedRatio : 0;
            const rollingEase = 1 - Math.exp(-AUDIO_SMOOTH * dt);
            this.rollingGain.gain.value += (targetGain - this.rollingGain.gain.value) * rollingEase;
        }
    }
}
