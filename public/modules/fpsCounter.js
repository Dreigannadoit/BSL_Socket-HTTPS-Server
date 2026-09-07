// A small, self-contained FPS readout pinned to the top-right corner — same
// dark/monospace panel look devTools.js's panel already uses, so it reads
// as part of the same UI language rather than a mismatched debug overlay.
//
// Text updates on a fixed cadence (UPDATE_INTERVAL) instead of every frame:
// a number that changes every single frame is illegible, and there's no
// reason to touch the DOM 150-200+ times a second for a purely diagnostic
// readout. Averages FPS over that window, and also tracks the window's
// WORST single frame — the average alone hides hitches (a level streaming
// in, a GC pause, a physics spike) that the minimum makes obvious, and the
// minimum is usually the number that actually matters when deciding what to
// optimize next.
const UPDATE_INTERVAL = 0.5; // seconds

export class FpsCounter {
    constructor() {
        this.el = document.createElement("div");
        this.el.style.cssText = `
            position: fixed; top: 12px; right: 16px;
            z-index: 9999; background: rgba(0, 0, 0, 0.55); color: #7CFF8E;
            font-family: monospace; font-size: 13px; font-weight: 600;
            padding: 6px 10px; border-radius: 6px;
            border: 1px solid rgba(255, 255, 255, 0.15);
            letter-spacing: 0.02em; user-select: none; pointer-events: none;
            white-space: pre;
        `;
        this.el.textContent = "FPS: --";
        document.body.appendChild(this.el);

        this._windowTime = 0;
        this._windowFrames = 0;
        this._windowMinFps = Infinity;
    }

    // Called once per rendered frame with THIS frame's raw delta time
    // (seconds) — pass the unclamped value straight from THREE.Clock, not
    // whatever clamped/capped dt the game logic uses for physics, or a real
    // hitch would get hidden behind that cap instead of showing up here.
    update(dt) {
        if (dt <= 0) return;
        const instantFps = 1 / dt;

        this._windowFrames++;
        this._windowTime += dt;
        if (instantFps < this._windowMinFps) this._windowMinFps = instantFps;

        if (this._windowTime >= UPDATE_INTERVAL) {
            const avgFps = this._windowFrames / this._windowTime;
            this.el.textContent = `FPS: ${Math.round(avgFps)}  (min ${Math.round(this._windowMinFps)})`;
            // Quick at-a-glance color cue: green at a solid 60+, amber if
            // it's dipping into the 30s-50s, red below that.
            this.el.style.color = avgFps >= 60 ? "#7CFF8E" : avgFps >= 30 ? "#FFD166" : "#FF6B6B";

            this._windowTime = 0;
            this._windowFrames = 0;
            this._windowMinFps = Infinity;
        }
    }
}
