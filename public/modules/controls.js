export class Controls {
    constructor() {
        this.keys = { forward: false, back: false, left: false, right: false };
        window.addEventListener("keydown", (e) => this._setKey(e.code, true));
        window.addEventListener("keyup", (e) => this._setKey(e.code, false));
    }

    _setKey(code, value) {
        switch (code) {
            case "KeyW":
            case "ArrowUp":
                this.keys.forward = value;
                break;
            case "KeyS":
            case "ArrowDown":
                this.keys.back = value;
                break;
            case "KeyA":
            case "ArrowLeft":
                this.keys.left = value;
                break;
            case "KeyD":
            case "ArrowRight":
                this.keys.right = value;
                break;
            default:
                return;
        }

        // First movement input received — dismiss the on-screen "use your
        // arrow keys / WASD" tutorial hint, but only once it's actually
        // had a chance to appear (i.e. the world has finished loading and
        // main.js's showControlTutorial() has run — see the ".show" class
        // check below). Otherwise mashing a key while the world is still
        // loading would hide a hint the player never got to see.
        if (value) this._hideTutorial();
    }

    _hideTutorial() {
        if (this._tutorialHidden) return;
        const tutorial = document.getElementById("controll_totorial");
        if (!tutorial) return;
        if (!tutorial.classList.contains("show")) return;
        this._tutorialHidden = true;

        // Freeze the hint at whatever opacity the flash animation
        // currently has it at, then explicitly transition it down to 0
        // over half a second. Doing this with inline styles (rather than
        // just toggling a "hide" class) sidesteps any inconsistency in
        // how browsers hand off from a running @keyframes animation
        // straight into a CSS transition — this way the fade is always
        // a real 0.5s fade, never an instant cut.
        const currentOpacity = getComputedStyle(tutorial).opacity;
        tutorial.style.animation = "none";
        tutorial.style.opacity = currentOpacity;
        // Force a reflow so the browser registers the frozen opacity
        // above as the transition's *starting* point, not its end point.
        void tutorial.offsetHeight;
        tutorial.style.transition = "opacity 2s ease";
        tutorial.style.opacity = "0";
    }
}
