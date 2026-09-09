// Full-screen "Loading world…" overlay. Everything (styles + DOM) is
// created here in JS rather than authored in each HTML file — that way any
// current or future page that calls startGame() (see main.js) gets the
// loading screen for free, with zero markup of its own required beyond the
// existing <link rel="stylesheet" href="/style.css"> every page already
// has (this module injects its own <style> tag, so even that isn't
// strictly required, just kept separate for tidiness).
const STYLE_ID = "loading-screen-style";

function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
        #loading-screen {
            position: fixed;
            inset: 0;
            z-index: 10000;
            display: flex;
            align-items: center;
            justify-content: center;
            background: radial-gradient(ellipse at center, #16232f 0%, #05070a 75%);
            transition: opacity 0.5s ease;
            opacity: 1;
        }
        #loading-screen.loading-screen--hidden {
            opacity: 0;
            pointer-events: none;
        }
        #loading-screen .loading-screen-inner {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 20px;
        }
        #loading-screen .loading-spinner {
            width: 48px;
            height: 48px;
            border-radius: 50%;
            border: 3px solid rgba(174, 239, 255, 0.15);
            border-top-color: #aeefff;
            animation: loading-screen-spin 0.9s linear infinite;
        }
        #loading-screen .loading-label {
            color: #d9f4ff;
            font-family: "Plus Jakarta Sans", sans-serif;
            font-size: 13px;
            letter-spacing: 0.12em;
            text-transform: uppercase;
            opacity: 0.85;
        }
        @keyframes loading-screen-spin {
            to { transform: rotate(360deg); }
        }
    `;
    document.head.appendChild(style);
}

export class LoadingScreen {
    constructor(label = "Loading world…") {
        injectStyles();

        this.el = document.createElement("div");
        this.el.id = "loading-screen";
        this.el.innerHTML = `
            <div class="loading-screen-inner">
                <div class="loading-spinner"></div>
                <div class="loading-label"></div>
            </div>
        `;
        document.body.appendChild(this.el);

        this.labelEl = this.el.querySelector(".loading-label");
        this.setLabel(label);
        this.hidden = false;
    }

    setLabel(text) {
        if (this.labelEl) this.labelEl.textContent = text;
    }

    // Fades the overlay out, then removes it from the DOM once the CSS
    // transition finishes (matches the 0.5s in the injected stylesheet).
    hide() {
        if (this.hidden) return;
        this.hidden = true;
        this.el.classList.add("loading-screen--hidden");
        const el = this.el;
        setTimeout(() => el.remove(), 550);
    }
}
