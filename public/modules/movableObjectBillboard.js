import * as THREE from "three";

// A genuine in-scene 3D billboard for the movable-object "reset?"
// confirmation — a small always-camera-facing panel with two clickable
// button meshes, built from canvas-texture planes (three.js's standard
// text-label technique) rather than a DOM overlay. It lives in the WebGL
// scene like everything else here (can be occluded by real geometry, moves
// with the world), and its buttons are genuinely clicked via raycasting
// against those meshes, not a DOM click handler.
export class MovableObjectBillboard {
    constructor(scene, camera, domElement) {
        this.camera = camera;
        this.domElement = domElement;
        this.visible = false;
        this.callbacks = null;

        // Everything renders after the normal scene and ignores depth so
        // the panel never fights z-fighting against the trigger/floor it's
        // floating just above, while still allowing bigger foreground
        // geometry (a wall the player rolled behind) to occlude it below.
        this.group = new THREE.Group();
        this.group.visible = false;
        this.group.renderOrder = 999;

        this.panel = this._makeQuad(1.6, 0.8, this._drawPanel());
        this.group.add(this.panel);

        this.yesButton = this._makeQuad(0.6, 0.32, this._drawButton("Yes", "#33ccff", "#04141c"));
        this.yesButton.position.set(-0.36, -0.18, 0.01);
        this.group.add(this.yesButton);

        this.noButton = this._makeQuad(0.6, 0.32, this._drawButton("No", "#e6e9f2", "#12161f"));
        this.noButton.position.set(0.36, -0.18, 0.01);
        this.group.add(this.noButton);

        scene.add(this.group);

        this.raycaster = new THREE.Raycaster();
        this.pointer = new THREE.Vector2();
        this._onClick = this._onClick.bind(this);
        this._onMove = this._onMove.bind(this);
        domElement.addEventListener("click", this._onClick);
        domElement.addEventListener("pointermove", this._onMove);
    }

    _makeQuad(width, height, canvas) {
        const texture = new THREE.CanvasTexture(canvas);
        if ("colorSpace" in texture) texture.colorSpace = THREE.SRGBColorSpace;
        const material = new THREE.MeshBasicMaterial({
            map: texture,
            transparent: true,
            depthWrite: false,
            depthTest: true,
        });
        const geometry = new THREE.PlaneGeometry(width, height);
        return new THREE.Mesh(geometry, material);
    }

    _drawPanel() {
        const canvas = document.createElement("canvas");
        canvas.width = 512;
        canvas.height = 256;
        const ctx = canvas.getContext("2d");

        this._roundRect(ctx, 6, 6, canvas.width - 12, canvas.height - 12, 30);
        ctx.fillStyle = "rgba(18, 22, 31, 0.92)";
        ctx.fill();
        ctx.lineWidth = 4;
        ctx.strokeStyle = "rgba(255, 255, 255, 0.18)";
        ctx.stroke();

        ctx.fillStyle = "#ffffff";
        ctx.font = "600 34px 'Plus Jakarta Sans', sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        this._wrapText(ctx, "Reset these objects to their original position?", canvas.width / 2, 92, 440, 42);

        return canvas;
    }

    _drawButton(label, bg, fg) {
        const canvas = document.createElement("canvas");
        canvas.width = 256;
        canvas.height = 128;
        const ctx = canvas.getContext("2d");

        this._roundRect(ctx, 4, 4, canvas.width - 8, canvas.height - 8, 24);
        ctx.fillStyle = bg;
        ctx.fill();

        ctx.fillStyle = fg;
        ctx.font = "700 46px 'Plus Jakarta Sans', sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(label, canvas.width / 2, canvas.height / 2 + 3);

        return canvas;
    }

    _roundRect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
    }

    _wrapText(ctx, text, cx, cy, maxWidth, lineHeight) {
        const words = text.split(" ");
        const lines = [];
        let line = "";
        for (const word of words) {
            const test = line ? `${line} ${word}` : word;
            if (line && ctx.measureText(test).width > maxWidth) {
                lines.push(line);
                line = word;
            } else {
                line = test;
            }
        }
        if (line) lines.push(line);

        const startY = cy - ((lines.length - 1) * lineHeight) / 2;
        lines.forEach((l, i) => ctx.fillText(l, cx, startY + i * lineHeight));
    }

    // worldPosition: THREE.Vector3 — already the anchor point (i.e. 1m
    // above the trigger; MovableObjectSystem computes that offset, this
    // class just places its group there). callbacks: { onConfirm, onCancel }.
    show(worldPosition, { onConfirm, onCancel }) {
        this.group.position.copy(worldPosition);
        this.visible = true;
        this.group.visible = true;
        this.callbacks = { onConfirm, onCancel };
    }

    hide() {
        this.visible = false;
        this.group.visible = false;
        this.callbacks = null;
    }

    // Called every frame from main.js's animate() with the live camera.
    // Copying the camera's world quaternion onto the group is the standard
    // "always face the viewer" billboarding technique — the same thing a
    // THREE.Sprite does internally, just applied to a group of ordinary
    // meshes (needed here since a Sprite's plane can't be individually
    // raycast as two separately clickable buttons the way discrete meshes
    // can).
    update(camera) {
        if (!this.visible) return;
        this.group.quaternion.copy(camera.quaternion);
    }

    _updatePointerNDC(event) {
        const rect = this.domElement.getBoundingClientRect();
        this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    }

    _pick(event) {
        this._updatePointerNDC(event);
        this.raycaster.setFromCamera(this.pointer, this.camera);
        return this.raycaster.intersectObjects([this.yesButton, this.noButton], false);
    }

    _onClick(event) {
        if (!this.visible || !this.callbacks) return;
        const hits = this._pick(event);
        if (hits.length === 0) return;
        const hit = hits[0].object;
        if (hit === this.yesButton) this.callbacks.onConfirm();
        else if (hit === this.noButton) this.callbacks.onCancel();
    }

    _onMove(event) {
        if (!this.visible) {
            this.domElement.style.cursor = "";
            return;
        }
        const hits = this._pick(event);
        this.domElement.style.cursor = hits.length > 0 ? "pointer" : "";
    }

    dispose() {
        this.domElement.removeEventListener("click", this._onClick);
        this.domElement.removeEventListener("pointermove", this._onMove);
    }
}
