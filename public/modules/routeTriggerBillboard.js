import * as THREE from "three";

// Camera-facing 3D billboard for RouteTriggerSystem's "Press Enter for
// <label>" prompt — same canvas-texture-plane billboarding technique as
// MovableObjectBillboard, except the text is redrawn per-trigger.
//
// The panel's WORLD-SPACE size is intentionally fixed and identical for
// every trigger (see PANEL_WIDTH/PANEL_HEIGHT below) — this level's
// triggers sit only ~1.5-2m apart (see RouteTriggerSystem's class
// comment), so a panel that grows wider for long labels would visually
// bleed into a neighboring trigger's space depending on which label was
// last drawn. Long labels are handled by shrinking the font to fit the
// fixed panel instead, falling back to two lines if even the minimum
// font size can't fit on one.
export class RouteTriggerBillboard {
    constructor(scene, camera, domElement) {
        this.camera = camera;
        this.domElement = domElement;
        this.visible = false;
        this.callbacks = null;
        this.currentLabel = null;

        this.group = new THREE.Group();
        this.group.visible = false;
        this.group.renderOrder = 999;

        // Canvas resolution is fixed and shared by every trigger. Sized a
        // bit taller than a single line so a two-line fallback (see
        // _drawPanel) has room without needing a resize.
        this.canvas = document.createElement("canvas");
        this.canvas.width = 900;
        this.canvas.height = 220;
        this.texture = new THREE.CanvasTexture(this.canvas);
        if ("colorSpace" in this.texture) this.texture.colorSpace = THREE.SRGBColorSpace;

        const material = new THREE.MeshBasicMaterial({
            map: this.texture,
            transparent: true,
            depthWrite: false,
            depthTest: true,
        });

        // Fixed world size for every trigger — never changes per label.
        this.PANEL_WIDTH = 2.2;
        this.PANEL_HEIGHT = 0.54; // matches the canvas's 900/220 aspect ratio
        const geometry = new THREE.PlaneGeometry(this.PANEL_WIDTH, this.PANEL_HEIGHT);
        this.panel = new THREE.Mesh(geometry, material);
        this.group.add(this.panel);

        scene.add(this.group);

        this.MAX_FONT_SIZE = 38;
        this.MIN_FONT_SIZE = 20; // below this, wrap to two lines instead of shrinking further
        this.PADDING_X = 40;     // horizontal margin either side, in canvas px

        this._onKeyDown = this._onKeyDown.bind(this);
        window.addEventListener("keydown", this._onKeyDown);
    }

    _fontString(size) {
        return `600 ${size}px 'Plus Jakarta Sans', sans-serif`;
    }

    // Finds the largest font size (down to MIN_FONT_SIZE) at which `text`
    // fits within the canvas's usable width on a single line.
    _fitSingleLine(ctx, text, maxWidth) {
        for (let size = this.MAX_FONT_SIZE; size >= this.MIN_FONT_SIZE; size -= 2) {
            ctx.font = this._fontString(size);
            if (ctx.measureText(text).width <= maxWidth) return size;
        }
        return this.MIN_FONT_SIZE;
    }

    _drawPanel(label) {
        const ctx = this.canvas.getContext("2d");
        const { width, height } = this.canvas;
        const maxTextWidth = width - this.PADDING_X * 2;
        const fullText = `Press Enter for ${label}`;

        ctx.clearRect(0, 0, width, height);

        this._roundRect(ctx, 6, 6, width - 12, height - 12, 24);
        ctx.fillStyle = "rgba(18, 22, 31, 0.92)";
        ctx.fill();
        ctx.lineWidth = 4;
        ctx.strokeStyle = "rgba(255, 230, 0, 0.4)";
        ctx.stroke();

        ctx.fillStyle = "#ffffff";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";

        // Try the whole thing on one line first, shrinking font as needed.
        const oneLineFit = this._fitSingleLine(ctx, fullText, maxTextWidth);
        ctx.font = this._fontString(oneLineFit);
        if (ctx.measureText(fullText).width <= maxTextWidth) {
            ctx.fillText(fullText, width / 2, height / 2 + 2);
        } else {
            // Even the minimum font can't fit it on one line — split into
            // two lines: "Press Enter for" on top, the label itself below.
            // Each line gets its own shrink-to-fit pass since the label
            // alone is a different (usually shorter) string than the
            // combined text.
            const line1 = "Press Enter for";
            const line2 = label;
            const size1 = this._fitSingleLine(ctx, line1, maxTextWidth);
            const size2 = this._fitSingleLine(ctx, line2, maxTextWidth);
            const size = Math.min(size1, size2);

            ctx.font = this._fontString(size);
            const lineGap = size * 1.15;
            ctx.fillText(line1, width / 2, height / 2 - lineGap / 2);
            ctx.fillText(line2, width / 2, height / 2 + lineGap / 2);
        }

        this.texture.needsUpdate = true;
        // Panel geometry is intentionally NOT touched here — it stays at
        // its fixed PANEL_WIDTH/PANEL_HEIGHT for every trigger.
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

    update(camera) {
        if (!this.visible) return;
        this.group.quaternion.copy(camera.quaternion);
    }

    _onKeyDown(event) {
        if (!this.visible || !this.callbacks) return;
        if (event.code !== "Enter" && event.code !== "NumpadEnter") return;
        if (event.repeat) return;
        const active = document.activeElement;
        if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable)) return;

        this.callbacks.onConfirm();
    }

    dispose() {
        window.removeEventListener("keydown", this._onKeyDown);
    }
}