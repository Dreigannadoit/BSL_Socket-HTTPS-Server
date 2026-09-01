const MODE_LABELS = {
    freeroam: "Free Roam",
    speedrun: "Speedrun",
    timetrial: "Collection Time Trial",
};

// A small, self-contained HUD overlay for the three selectable game modes:
// a persistent mode/timer readout (now split into two standalone chips —
// modeLabel and statLine) and a centered modal popup reused for every
// result/confirmation dialog (Free Roam's "end run?" prompt, Speedrun's
// finish time, Time Trial's success/fail screen).
//
// Everything here is built and styled in JS rather than depending on the
// page's external stylesheet, so it renders correctly regardless of what's
// in style.css.
export class GameModeUI {
    constructor() {
        this._timerText = "";
        this._orbText = "";
        this._buildBadge();
        this._buildPopup();
        this._buildToast();
    }

    _buildBadge() {
        // Shared look for the three standalone containers: white background,
        // black text, small padding, rounded corners.
        const chipBase = `
            font-family: 'Plus Jakarta Sans', sans-serif; color: #000;
            background: #fff; border: 1px solid rgba(0,0,0,0.15);
            border-radius: 10px; padding: 5px 10px; text-align: center;
            pointer-events: none;
        `;

        this.modeLabel = document.createElement("div");
        this.modeLabel.style.cssText = `
            ${chipBase}
            position: fixed; top: 16px; left: 50%; transform: translateX(-50%); z-index: 20;
            font-size: 13px; opacity: 0.9; letter-spacing: 0.04em; text-transform: uppercase;
            min-width: 150px; border-radius: 90px;
        `;

        this.statLine = document.createElement("div");
        this.statLine.style.cssText = `
            ${chipBase}
            position: fixed; top: 60px; left: 50%; transform: translateX(-50%); z-index: 20; opacity: 0.9;
            font-size: 18px; font-weight: 600; display: none;
            min-width: 150px; border-radius: 90px;
        `;

        this.flashLine = document.createElement("div");
        this.flashLine.style.cssText = `
            ${chipBase}
            position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 20; 
            font-size: 18px; font-weight: 600; color: #030303; min-height: 16px;
            opacity: 0; transition: opacity 0.4s ease; border-radius: 90px; padding: 10px 15px;
        `;

        document.body.appendChild(this.modeLabel);
        document.body.appendChild(this.statLine);
        document.body.appendChild(this.flashLine);

        this.setMode(null);
    }

    _buildPopup() {
        const overlay = document.createElement("div");
        overlay.style.cssText = `
            position: fixed; inset: 0; z-index: 30; display: none;
            align-items: center; justify-content: center;
            background: rgba(4, 6, 10, 0.6);
            font-family: 'Plus Jakarta Sans', sans-serif;
        `;

        const card = document.createElement("div");
        card.style.cssText = `
            background: #12161f; color: #fff; border-radius: 16px; padding: 28px 32px;
            min-width: 280px; max-width: 90vw; text-align: center;
            border: 1px solid rgba(255,255,255,0.12); box-shadow: 0 20px 60px rgba(0,0,0,0.5);
        `;

        this.popupTitle = document.createElement("h2");
        this.popupTitle.style.cssText = "margin: 0 0 8px; font-size: 22px;";

        this.popupMessage = document.createElement("p");
        // white-space: pre-line lets showPopup() callers put the result
        // (e.g. "How the hell is that even possible??") on one line and
        // the completed time on the next via a plain "\n", without needing
        // to reach for innerHTML/<br>.
        this.popupMessage.style.cssText =
            "margin: 0 0 20px; opacity: 0.85; font-size: 15px; line-height: 1.4; white-space: pre-line;";

        this.popupButtons = document.createElement("div");
        this.popupButtons.style.cssText = "display: flex; gap: 10px; justify-content: center;";

        card.appendChild(this.popupTitle);
        card.appendChild(this.popupMessage);
        card.appendChild(this.popupButtons);
        overlay.appendChild(card);
        document.body.appendChild(overlay);
        this.popupOverlay = overlay;
    }

    // A separate, transient bottom-middle banner — distinct from the
    // top-middle badge chips' flashMessage() — used for the two Collection
    // Time Trial objective callouts ("Find all the orbs" / "Follow the path
    // to the End Marker quickly").
    _buildToast() {
        const toast = document.createElement("div");
        toast.style.cssText = `
            position: fixed; left: 50%; bottom: 50%; z-index: 25;
            transform: translate(-50%, 12px);
            font-family: 'Plus Jakarta Sans', sans-serif; color: #fff;
            background: rgba(10, 14, 20, 0.75); border: 1px solid rgba(255,255,255,0.15);
            border-radius: 999px; padding: 10px 22px; font-size: 15px; font-weight: 600;
            text-align: center; pointer-events: none; opacity: 0;
            transition: opacity 0.35s ease, transform 0.35s ease;
        `;
        document.body.appendChild(toast);
        this.toast = toast;
    }

    // text: message to show. duration: ms before it fades back out
    // (defaults to 2600ms).
    showToast(text, duration = 2600) {
        this.toast.textContent = text;
        this.toast.style.opacity = "1";
        this.toast.style.transform = "translate(-50%, 0)";
        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => {
            this.toast.style.opacity = "0";
            this.toast.style.transform = "translate(-50%, 12px)";
        }, duration);
    }

    // mode: null | "freeroam" | "speedrun" | "timetrial" — the persistent
    // indication of which mode the player is currently in.
    setMode(mode) {
        this.modeLabel.textContent = mode ? MODE_LABELS[mode] : "No mode";
        if (!mode) {
            this._timerText = "";
            this._orbText = "";
            this._renderStat();
        }
    }

    // text: a formatted "m:ss.ss" string, or null to leave it untouched.
    setTimer(text) {
        if (text === null || text === undefined) return;
        this._timerText = text;
        this._renderStat();
    }

    // count/total: numbers, or null to clear the orb readout (e.g. leaving
    // Time Trial).
    setOrbCount(count, total) {
        this._orbText = count === null || count === undefined ? "" : `${count}/${total} orbs`;
        this._renderStat();
    }

    _renderStat() {
        const parts = [this._timerText, this._orbText].filter(Boolean);
        this.statLine.textContent = parts.join(" \u00b7 ");
        this.statLine.style.display = parts.length ? "block" : "none";
    }

    // A short, self-dismissing hint centered in the window (mode selected,
    // "GO!", "collect all the orbs first", etc).
    flashMessage(text) {
        this.flashLine.textContent = text;
        this.flashLine.style.opacity = "1";
        clearTimeout(this._flashTimer);
        this._flashTimer = setTimeout(() => {
            this.flashLine.style.opacity = "0";
        }, 2400);
    }

    // buttons: [{ label, onClick }, ...]
    showPopup({ title, message, buttons }) {
        this.popupTitle.textContent = title;
        this.popupMessage.textContent = message;
        this.popupButtons.innerHTML = "";

        for (const { label, onClick } of buttons) {
            const btn = document.createElement("button");
            btn.textContent = label;
            btn.style.cssText = `
                padding: 10px 20px; border-radius: 8px; border: none; cursor: pointer;
                font-family: inherit; font-size: 14px; font-weight: 600;
                background: #33ccff; color: #04141c;
            `;
            btn.addEventListener("click", onClick);
            this.popupButtons.appendChild(btn);
        }

        this.popupOverlay.style.display = "flex";
    }

    hidePopup() {
        this.popupOverlay.style.display = "none";
    }
}