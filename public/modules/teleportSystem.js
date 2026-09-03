import { TELEPORT_HOTSPOT_OFFSET, TELEPORT_LIFT } from "./config.js";

// Dev-tool feature: pressing "1".."5" teleports the ball near (never
// directly onto) the matching Hotspot_N marker registered in
// HotspotSystem. Disabled by default — gated behind a "canTeleportToHotspot"
// checkbox rendered in a small dev-tool panel docked to the right-middle of
// the screen, built and styled in JS the same way GameModeUI builds its own
// overlay chips, so it doesn't depend on anything in style.css.
export class TeleportSystem {
    // `hotspotSystem` is read live at teleport time (hotspot.position), so
    // this can be constructed before the level (and its hotspots) finish
    // loading. `respawnSystem` is optional — when given, the respawn
    // anchor/history is re-seeded at the new spot so falling right after a
    // teleport doesn't snap the ball all the way back to wherever it was
    // standing before.
    constructor(ballBody, hotspotSystem, respawnSystem = null) {
        this.ballBody = ballBody;
        this.hotspotSystem = hotspotSystem;
        this.respawnSystem = respawnSystem;

        // Off by default — only the checkbox in the dev-tool panel flips
        // this, never on by itself.
        this.enabled = true;

        this._buildDevTool();
        this._onKeyDown = this._onKeyDown.bind(this);
        window.addEventListener("keydown", this._onKeyDown);
    }

    _buildDevTool() {
        this.panel = document.createElement("div");
        this.panel.style.cssText = `
            position: fixed; top: 50%; right: 16px; transform: translateY(-50%);
            z-index: 9999; background: rgba(0, 0, 0, 0.6); color: #eee;
            font-family: monospace; font-size: 12px; padding: 10px 12px;
            border-radius: 6px; border: 1px solid rgba(255, 255, 255, 0.15);
            display: flex; flex-direction: column; gap: 6px; user-select: none;
        `;

        const title = document.createElement("div");
        title.textContent = "Dev Tools";
        title.style.cssText = `
            font-weight: 600; opacity: 0.8; letter-spacing: 0.04em;
            text-transform: uppercase; font-size: 10px;
        `;
        this.panel.appendChild(title);

        const row = document.createElement("label");
        row.style.cssText = "display: flex; align-items: center; gap: 6px; cursor: pointer;";

        this.checkbox = document.createElement("input");
        this.checkbox.type = "checkbox";
        this.checkbox.id = "canTeleportToHotspot";
        // Disabled by default — the player must opt in via this checkbox.
        this.checkbox.checked = false;
        this.checkbox.addEventListener("change", () => {
            this.enabled = this.checkbox.checked;
        });

        const labelText = document.createElement("span");
        labelText.textContent = "canTeleportToHotspot";

        row.appendChild(this.checkbox);
        row.appendChild(labelText);
        this.panel.appendChild(row);

        const hint = document.createElement("div");
        hint.textContent = "Press 1-5 to teleport near a hotspot";
        hint.style.cssText = "opacity: 0.55; font-size: 10px; max-width: 150px;";
        this.panel.appendChild(hint);

        document.body.appendChild(this.panel);
    }

    _onKeyDown(e) {
        if (!this.enabled) return;

        // Don't hijack digit keys while the user is typing into some other
        // input/textarea on the page (the checkbox itself doesn't care
        // about digit keys, but this keeps the guard generic/future-proof).
        const target = e.target;
        if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;

        if (!/^[1-5]$/.test(e.key)) return;

        this._teleportToHotspot(`Hotspot_${e.key}`);
    }

    _teleportToHotspot(name) {
        const hotspot = this.hotspotSystem.hotspots.find((h) => h.name === name);
        if (!hotspot) return; // level hasn't loaded yet, or this hotspot isn't registered

        const pos = hotspot.position;

        // Land a short diagonal offset away from the marker rather than
        // directly on top of it — far enough to sit outside the hotspot's
        // own enter/exit trigger radius, so the popup doesn't fire the
        // instant the teleport lands; the player still has to roll in.
        const dx = TELEPORT_HOTSPOT_OFFSET * Math.SQRT1_2;
        const dz = TELEPORT_HOTSPOT_OFFSET * Math.SQRT1_2;

        const ballBody = this.ballBody;
        ballBody.position.set(pos.x + dx, pos.y + TELEPORT_LIFT, pos.z + dz);
        ballBody.velocity.set(0, 0, 0);
        ballBody.angularVelocity.set(0, 0, 0);

        if (this.respawnSystem) {
            const newPos = { x: pos.x + dx, y: pos.y + TELEPORT_LIFT, z: pos.z + dz };
            this.respawnSystem.resetGroundedHistory(newPos);
            this.respawnSystem.lastSafePosition.set(newPos.x, newPos.y, newPos.z);
        }
    }
}
