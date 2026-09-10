import * as THREE from "three";

// Camera-facing 3D billboard for RouteTriggerSystem's "Press Enter for
// <label>" prompt — same canvas-texture-plane billboarding technique as
// MovableObjectBillboard (three.js's standard text-label trick), except the
// text is redrawn per-trigger rather than being fixed, since each route
// trigger (About page / Github / LinkedIn / ...) has its own label.
//
// Purely informational, same as MovableObjectBillboard: confirming is a
// keyboard action (Enter), not a click, so there's nothing on the panel to
// raycast against. Rolling off the trigger dismisses it (handled by
// RouteTriggerSystem.update), so there's no separate cancel affordance to
// draw either. The player's own movement is completely untouched by this —
// showing/hiding the panel never freezes input.
export class RouteTriggerBillboard {
    constructor(scene, camera, domElement) {
        this.camera = camera;
        this.domElement = domElement;
        this.visible = false;
        this.callbacks = null;
        this.currentLabel = null;

        // Renders after the normal scene and ignores depth so the panel
        // never fights z-fighting against the trigger/floor it's floating
        // just above, while still allowing bigger foreground geometry to
        // occlude it — same convention as MovableObjectBillboard.
        this.group = new THREE.Group();
        this.group.visible = false;
        this.group.renderOrder = 999;

        // One canvas/texture reused across every trigger — _drawPanel()
        // repaints it whenever the label actually changes, instead of
        // allocating a fresh canvas per trigger.
        this.canvas = document.createElement("canvas");
        this.canvas.width = 512;
        this.canvas.height = 128;
        this.texture = new THREE.CanvasTexture(this.canvas);
        if ("colorSpace" in this.texture) this.texture.colorSpace = THREE.SRGBColorSpace;

        const material = new THREE.MeshBasicMaterial({
            map: this.texture,
            transparent: true,
            depthWrite: false,
            depthTest: true,
        });
        const geometry = new THREE.PlaneGeometry(1.8, 0.4);
        this.panel = new THREE.Mesh(geometry, material);
        this.group.add(this.panel);

        scene.add(this.group);

        // Window-level (not domElement-level) so it fires regardless of
        // what currently has DOM focus, same as MovableObjectBillboard —
        // except we explicitly bail if an actual input field (e.g.
        // DevTools' panel) is focused, so committing a value there with
        // Enter can't also fire a navigation behind it.
        this._onKeyDown = this._onKeyDown.bind(this);
        window.addEventListener("keydown", this._onKeyDown);
    }

    _drawPanel(label) {
        const ctx = this.canvas.getContext("2d");
        const { width, height } = this.canvas;
        ctx.clearRect(0, 0, width, height);

        this._roundRect(ctx, 6, 6, width - 12, height - 12, 24);
        ctx.fillStyle = "rgba(18, 22, 31, 0.92)";
        ctx.fill();
        ctx.lineWidth = 4;
        // Faint yellow ring — echoes the trigger marker's own glow color
        // (ROUTE_TRIGGER_GLOW_COLOR) so the panel visually belongs to it.
        ctx.strokeStyle = "rgba(255, 230, 0, 0.4)";
        ctx.stroke();

        ctx.fillStyle = "#ffffff";
        ctx.font = "600 38px 'Plus Jakarta Sans', sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(`Press Enter for ${label}`, width / 2, height / 2 + 2);

        this.texture.needsUpdate = true;
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

    // worldPosition: THREE.Vector3 — already the anchor point (
    // RouteTriggerSystem computes the offset above the trigger).
    // label: this trigger's display name, e.g. "My Github".
    // callbacks: { onConfirm } — called when Enter is pressed while the
    // panel is visible.
    show(worldPosition, label, { onConfirm }) {
        if (label !== this.currentLabel) {
            this._drawPanel(label);
            this.currentLabel = label;
        }
        this.group.position.copy(worldPosition);
        this.visible = true;
        this.group.visible = true;
        this.callbacks = { onConfirm };
    }

    hide() {
        this.visible = false;
        this.group.visible = false;
        this.callbacks = null;
        this.currentLabel = null;
    }

    // Called every frame from main.js's animate() with the live camera.
    // Copying the camera's world quaternion onto the group is the standard
    // "always face the viewer" billboarding technique — same as
    // MovableObjectBillboard.
    update(camera) {
        if (!this.visible) return;
        this.group.quaternion.copy(camera.quaternion);
    }

    _onKeyDown(event) {
        if (!this.visible || !this.callbacks) return;
        if (event.code !== "Enter" && event.code !== "NumpadEnter") return;
        // Ignore OS key-repeat so holding Enter down doesn't fire the
        // confirm callback (and therefore the page navigation) many times.
        if (event.repeat) return;
        // A focused text field (e.g. DevTools' position/rotation inputs)
        // gets first claim on Enter.
        const active = document.activeElement;
        if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable)) return;

        this.callbacks.onConfirm();
    }

    dispose() {
        window.removeEventListener("keydown", this._onKeyDown);
    }
}
