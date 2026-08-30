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
        }
    }
}
