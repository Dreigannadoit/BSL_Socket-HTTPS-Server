import * as THREE from "three";

// A DOM popup that tracks a moving 3D world point every frame, rather than
// an actual mesh living in the scene — this codebase's entire UI layer is
// DOM-driven (GameModeUI, HotspotSystem's popupEl, DevTools' panel), so this
// follows the same pattern instead of introducing a one-off CSS3DRenderer/
// raycasting stack. That choice gets "always faces the camera" for free
// (it's flat 2D content, so there's nothing to billboard), and "positioned
// N meters above the trigger" by re-projecting that world point to screen
// space in update() every frame as the follow-camera moves.
//
// Used by MovableObjectSystem for its per-section "reset objects?" prompt.
export class MovableObjectUI {
    constructor() {
        this.anchor = new THREE.Vector3();
        this.visible = false;

        this.el = document.createElement("div");
        this.el.style.cssText = `
            position: fixed; left: 0; top: 0; z-index: 25; display: none;
            transform: translate(-50%, -100%);
            font-family: 'Plus Jakarta Sans', sans-serif;
            background: #12161f; color: #fff; border-radius: 14px;
            padding: 14px 18px; text-align: center; min-width: 210px;
            border: 1px solid rgba(255,255,255,0.15);
            box-shadow: 0 12px 30px rgba(0,0,0,0.45);
        `;

        const text = document.createElement("div");
        text.textContent = "Reset these objects to their original position?";
        text.style.cssText =
            "font-size: 14px; font-weight: 600; margin-bottom: 10px; line-height: 1.3; pointer-events: none;";

        const row = document.createElement("div");
        row.style.cssText = "display: flex; gap: 8px; justify-content: center;";

        this.yesBtn = document.createElement("button");
        this.yesBtn.textContent = "Yes";
        this.noBtn = document.createElement("button");
        this.noBtn.textContent = "No";
        for (const btn of [this.yesBtn, this.noBtn]) {
            btn.style.cssText = `
                padding: 7px 16px; border-radius: 8px; border: none; cursor: pointer;
                font-family: inherit; font-size: 13px; font-weight: 600;
            `;
        }
        this.yesBtn.style.background = "#33ccff";
        this.yesBtn.style.color = "#04141c";
        this.noBtn.style.background = "rgba(255,255,255,0.12)";
        this.noBtn.style.color = "#fff";

        row.appendChild(this.yesBtn);
        row.appendChild(this.noBtn);
        this.el.appendChild(text);
        this.el.appendChild(row);
        document.body.appendChild(this.el);
    }

    // worldPosition: THREE.Vector3 — already the anchor point (i.e. 1m
    // above the trigger; MovableObjectSystem computes that offset, this
    // class just tracks whatever point it's handed). callbacks:
    // { onConfirm, onCancel }.
    show(worldPosition, { onConfirm, onCancel }) {
        this.anchor.copy(worldPosition);
        this.visible = true;

        // Replace rather than accumulate listeners each time show() is
        // called — onConfirm/onCancel close over a different section every
        // time a new trigger is entered.
        this.yesBtn.onclick = () => onConfirm();
        this.noBtn.onclick = () => onCancel();
    }

    hide() {
        this.visible = false;
        this.el.style.display = "none";
    }

    // Called every frame from main.js's animate() with the live camera.
    // Re-projects the anchor to screen space so the popup tracks its
    // authored world position as the follow-camera moves, and hides itself
    // (without touching `visible`/the callbacks) whenever that point is
    // currently behind the camera, so it can't flash up inverted/huge at
    // the edge of the frustum.
    update(camera) {
        if (!this.visible) return;

        // update()'s manual .project() call needs this frame's camera
        // matrices, which aren't guaranteed fresh yet outside a render
        // pass — cheap enough to force explicitly rather than depend on
        // call order in main.js.
        camera.updateMatrixWorld();

        const projected = this.anchor.clone().project(camera);
        if (projected.z > 1) {
            this.el.style.display = "none";
            return;
        }

        this.el.style.display = "block";
        const x = (projected.x * 0.5 + 0.5) * window.innerWidth;
        const y = (1 - (projected.y * 0.5 + 0.5)) * window.innerHeight;
        this.el.style.transform = `translate(-50%, -100%) translate(${x}px, ${y}px)`;
    }
}
