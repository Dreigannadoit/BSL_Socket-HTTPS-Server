import * as THREE from "three";

// A genuine in-scene 3D billboard for the movable-object "reset?" prompt —
// a small always-camera-facing panel built from a canvas-texture plane
// (three.js's standard text-label technique), living in the WebGL scene
// like everything else here (can be occluded by real geometry, moves with
// the world) rather than as a DOM overlay.
//
// The panel is purely informational ("Press Enter to Reset") — confirming
// is a keyboard action (see _onKeyDown), not a click, so there's nothing on
// the panel itself to raycast against. Rolling off the trigger still
// dismisses it as an implicit "No" (handled by MovableObjectSystem.update),
// so there's no separate cancel affordance to draw either.
export class MovableObjectBillboard {
    constructor(scene, camera, domElement) {
        this.camera = camera;
        this.domElement = domElement;
        this.visible = false;
        this.callbacks = null;

        // Renders after the normal scene and ignores depth so the panel
        // never fights z-fighting against the trigger/floor it's floating
        // just above, while still allowing bigger foreground geometry (a
        // wall the player rolled behind) to occlude it.
        this.group = new THREE.Group();
        this.group.visible = false;
        this.group.renderOrder = 999;

        this.panel = this._makeQuad(1.6, 0.4, this._drawPanel());
        this.group.add(this.panel);

        scene.add(this.group);

        // Window-level (not domElement-level) so it fires regardless of
        // what currently has DOM focus, same as controls.js's movement
        // keys — except we explicitly bail if an actual input field (e.g.
        // DevTools' panel) is focused, so committing a value there with
        // Enter can't also fire a reset behind it.
        this._onKeyDown = this._onKeyDown.bind(this);
        window.addEventListener("keydown", this._onKeyDown);
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
        canvas.height = 128;
        const ctx = canvas.getContext("2d");

        this._roundRect(ctx, 6, 6, canvas.width - 12, canvas.height - 12, 24);
        ctx.fillStyle = "rgba(18, 22, 31, 0.92)";
        ctx.fill();
        ctx.lineWidth = 4;
        ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
        ctx.stroke();

        ctx.fillStyle = "#ffffff";
        ctx.font = "600 40px 'Plus Jakarta Sans', sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("Press Enter to Reset", canvas.width / 2, canvas.height / 2 + 2);

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

    // worldPosition: THREE.Vector3 — already the anchor point (i.e. 1m
    // above the trigger; MovableObjectSystem computes that offset, this
    // class just places its group there). callbacks: { onConfirm, onCancel }
    // — onCancel is kept in the signature (and still called on roll-off by
    // MovableObjectSystem) even though this panel has no button for it.
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
    // THREE.Sprite does internally, just applied to a plain mesh.
    update(camera) {
        if (!this.visible) return;
        this.group.quaternion.copy(camera.quaternion);
    }

    _onKeyDown(event) {
        if (!this.visible || !this.callbacks) return;
        if (event.code !== "Enter" && event.code !== "NumpadEnter") return;
        // Ignore OS key-repeat so holding Enter down doesn't fire the
        // confirm callback (and therefore the reset) many times over.
        if (event.repeat) return;
        // A focused text field (e.g. DevTools' position/rotation inputs)
        // gets first claim on Enter — committing a value there shouldn't
        // also reset objects behind it.
        const active = document.activeElement;
        if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable)) return;

        this.callbacks.onConfirm();
    }

    dispose() {
        window.removeEventListener("keydown", this._onKeyDown);
    }
}
