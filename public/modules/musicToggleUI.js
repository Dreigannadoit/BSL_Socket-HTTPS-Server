// Top-right "music on/off" button — toggles ONLY BackgroundMusicManager's
// home/about/rush tracks (see backgroundMusic.js's setMuted()). Never
// touches AudioManager's engine/rolling/bounce/hotspot SFX or a hotspot's
// H2-H5 Record_player narration clip; those keep playing either way.
//
// Stacked just below FpsCounter's top-right readout (top: 12px/right: 16px,
// ~30px tall) rather than sharing its row, so the two never overlap.
export class MusicToggleUI {
    constructor(backgroundMusic) {
        this.backgroundMusic = backgroundMusic;

        this.btn = document.createElement("button");
        this.btn.type = "button";
        this.btn.id = "music-toggle-button";
        Object.assign(this.btn.style, {
            position: "fixed",
            top: "56px",
            right: "16px",
            zIndex: "10000",
            display: "flex",
            alignItems: "center",
            gap: "8px",
            padding: "8px 14px",
            borderRadius: "999px",
            border: "1px solid rgba(255,255,255,0.25)",
            background: "rgba(15,15,20,0.82)",
            color: "#fff",
            fontFamily: "inherit",
            fontSize: "13px",
            fontWeight: "600",
            letterSpacing: "0.01em",
            cursor: "pointer",
            boxShadow: "0 6px 18px rgba(0,0,0,0.35)",
            backdropFilter: "blur(6px)",
        });
        this.btn.addEventListener("click", () => {
            const muted = this.backgroundMusic.toggleMuted();
            this._render(muted);
        });
        document.body.appendChild(this.btn);

        this._render(this.backgroundMusic.isMuted());
    }

    _render(muted) {
        // this.btn.textContent = muted ? "🔇 Music Off" : "🔊 Music On";
        this.btn.textContent = muted ? "🔇" : "🔊";
        this.btn.setAttribute("aria-pressed", String(!muted));
        this.btn.setAttribute("aria-label", muted ? "Unmute background music" : "Mute background music");
    }
}
