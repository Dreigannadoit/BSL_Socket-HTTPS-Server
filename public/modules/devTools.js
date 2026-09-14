import * as THREE from "three";

import {
    TELEPORT_HOTSPOT_OFFSET,
    TELEPORT_LIFT,
    GAME_MODE_FREE_ROAM,
    GAME_MODE_SPEEDRUN,
    GAME_MODE_TIME_TRIAL,
} from "./config.js";

// How much time a "+30s" Time Trial cheat press adds to the live
// countdown. Dev-tool-only value, not something any real game system reads.
const DEV_ADD_TIME_SECONDS = 30;

const RAD2DEG = 180 / Math.PI;
const DEG2RAD = Math.PI / 180;

// ── Camera Free Roam (free-look) tuning ──
// Note: this is deliberately NOT a Blender-style "orbit around a pivot"
// camera — rotating never moves the camera. `eye` (see _orbit state below)
// is the single source of truth for position; rotate only ever changes
// theta/phi (look direction), pan translates `eye` sideways/up-down, and
// zoom dollies `eye` forward/back along the current look direction.
const ORBIT_ROTATE_SPEED = 0.006; // radians per pixel of MMB drag
const ORBIT_PAN_SPEED = 0.02; // world units per pixel
const ORBIT_DRAG_ZOOM_SPEED = 0.02; // world units per pixel, Ctrl+MMB drag
const ORBIT_WHEEL_ZOOM_SPEED = 0.01; // world units per wheel-delta unit
// Keep phi just off the poles so look direction never flips underfoot.
const ORBIT_MIN_PHI = 0.001;
const ORBIT_MAX_PHI = Math.PI - 0.001;

const MODE_BUTTONS = [
    { mode: GAME_MODE_FREE_ROAM, label: "Free Roam" },
    { mode: GAME_MODE_SPEEDRUN, label: "Speedrun" },
    { mode: GAME_MODE_TIME_TRIAL, label: "Time Trial" },
];

// A single dev-tool panel docked to the right-middle of the screen,
// built/styled in JS the same way GameModeUI builds its own overlay chips
// (so it doesn't depend on anything in style.css). Everything in here is
// OFF/inert by default — each feature is opt-in via its own checkbox or an
// explicit button press, never automatic.
export class DevTools {
    // `hotspotSystem`/`gameModeManager` are read live (not snapshotted), so
    // this can be constructed before the level finishes loading.
    constructor({ ballBody, hotspotSystem, respawnSystem, player, gameModeManager, bloomRenderer, camera }) {
        this.ballBody = ballBody;
        this.hotspotSystem = hotspotSystem;
        this.respawnSystem = respawnSystem;
        this.player = player;
        this.gameModeManager = gameModeManager;
        this.bloomRenderer = bloomRenderer;
        this.camera = camera;

        // Off by default — only the "canTeleportToHotspot" checkbox flips
        // this, never on by itself.
        this.teleportEnabled = false;

        // Off by default — gates whether enter
        // Off by default — forces the grayscale effect on directly,
        // bypassing hotspot state entirely. Only useful for confirming the
        // render effect itself works, independent of whatever is/isn't
        // triggering it via a hotspot.
        this.grayscalePreview = false;

        // ON by default — matches the game's normal behavior (camera always
        // looks at the ball, via CameraController). Flipping this off hands
        // full manual control of the camera's position/rotation to the
        // fields below, and CameraController's own follow/lookAt logic is
        // skipped entirely for as long as it's off.
        this.lookAtPlayer = true;

        // Manual camera transform, only actually applied to the camera
        // while lookAtPlayer is off. Position is world units (same as
        // camera.position); rotation is stored in degrees for the UI and
        // converted to radians when applied. Seeded from the camera's
        // actual current transform so toggling lookAtPlayer off doesn't
        // snap the camera somewhere unexpected before the user edits
        // anything.
        this.manualCameraPosition = this.camera
            ? { x: this.camera.position.x, y: this.camera.position.y, z: this.camera.position.z }
            : { x: 0, y: 0, z: 0 };
        this.manualCameraRotation = this.camera
            ? {
                  x: RAD2DEG * this.camera.rotation.x,
                  y: RAD2DEG * this.camera.rotation.y,
                  z: RAD2DEG * this.camera.rotation.z,
              }
            : { x: 0, y: 0, z: 0 };

        // Hidden by default — Tab toggles visibility. The panel is still
        // built and appended to the DOM up front so all the wiring/state
        // works normally; only its display is gated.
        this.visible = false;

        // Off by default, and only ever reachable through the checkbox that
        // appears once lookAtPlayer is unchecked (see _buildCameraSection).
        // While on, MMB-drag/scroll on the game view drives the camera via
        // orbit math instead of the plain manual position/rotation fields —
        // but it still just writes into those same fields every frame, so
        // CameraController's manualOverride path (and the readouts/number
        // inputs) don't need to know orbit mode exists at all.
        this.freeRoamEnabled = false;
        this._orbit = {
            eye: new THREE.Vector3(), // the actual camera position — never moved by rotate
            theta: 0, // azimuth of look direction around world Y, radians
            phi: Math.PI / 3, // polar angle of look direction from world +Y, radians
            // null | "orbit" | "pan" | "zoom" — which behavior the held MMB
            // drag currently performs, decided once at mousedown time from
            // whichever modifier keys were down then.
            dragging: null,
            lastX: 0,
            lastY: 0,
        };
        // Scratch objects reused every frame so _applyOrbit/_panOrbit don't
        // allocate: `_orbitDirection` is the current unit look direction,
        // `_orbitLookTarget` is a throwaway point in front of `eye` used
        // only to feed Object3D.lookAt (never stored), and `_orbitDummy` is
        // what turns eye+lookTarget into a rotation via lookAt, without
        // touching the real camera.
        this._orbitDummy = new THREE.Object3D();
        this._orbitDirection = new THREE.Vector3();
        this._orbitLookTarget = new THREE.Vector3();

        this._buildPanel();
        this._onKeyDown = this._onKeyDown.bind(this);
        window.addEventListener("keydown", this._onKeyDown);

        // Registered once and always live; each handler checks
        // freeRoamEnabled itself, same as _onKeyDown already checks
        // teleportEnabled. Mouse/wheel (not just keydown) because orbit
        // needs to track MMB drags and the scroll wheel globally, not just
        // while focused on a particular element.
        this._onMouseDown = this._onMouseDown.bind(this);
        this._onMouseMove = this._onMouseMove.bind(this);
        this._onMouseUp = this._onMouseUp.bind(this);
        this._onWheel = this._onWheel.bind(this);
        window.addEventListener("mousedown", this._onMouseDown);
        window.addEventListener("mousemove", this._onMouseMove);
        window.addEventListener("mouseup", this._onMouseUp);
        window.addEventListener("wheel", this._onWheel, { passive: false });
    }

    _setVisible(visible) {
        this.visible = visible;
        this.panel.style.display = visible ? "flex" : "none";
    }

    // Called once a frame from the main loop to keep the position readout
    // live. Cheap enough (one textContent write) to just always run.
    update() {
        if (!this.visible) return;
        if (this.positionReadout) {
            const p = this.ballBody.position;
            this.positionReadout.textContent = `x: ${p.x.toFixed(2)}  y: ${p.y.toFixed(2)}  z: ${p.z.toFixed(2)}`;
        }

        if (this.camera && this.cameraPositionReadout && this.cameraRotationReadout) {
            const cp = this.camera.position;
            const cr = this.camera.rotation;
            this.cameraPositionReadout.textContent = `x: ${cp.x.toFixed(2)}  y: ${cp.y.toFixed(2)}  z: ${cp.z.toFixed(2)}`;
            this.cameraRotationReadout.textContent =
                `x: ${(RAD2DEG * cr.x).toFixed(2)}°  y: ${(RAD2DEG * cr.y).toFixed(2)}°  z: ${(RAD2DEG * cr.z).toFixed(2)}°`;

            // While lookAtPlayer is driving the camera, keep the manual
            // input fields mirroring the live values too — so they're
            // already showing something sensible the moment the user
            // unchecks lookAtPlayer, without needing to look at them
            // first. Skip a field the user currently has focused, so this
            // never fights with someone mid-edit.
            if (this.lookAtPlayer) {
                const active = document.activeElement;
                for (const axis of ["x", "y", "z"]) {
                    const posInput = this.cameraPosInputs[axis];
                    if (posInput !== active) {
                        this.manualCameraPosition[axis] = cp[axis];
                        posInput.value = cp[axis].toFixed(2);
                    }
                    const rotInput = this.cameraRotInputs[axis];
                    if (rotInput !== active) {
                        this.manualCameraRotation[axis] = RAD2DEG * cr[axis];
                        rotInput.value = (RAD2DEG * cr[axis]).toFixed(2);
                    }
                }
            }
        }
    }

    _buildPanel() {
        this.panel = document.createElement("div");
        this.panel.style.cssText = `
            position: fixed; top: 50%; right: 16px; transform: translateY(-50%);
            z-index: 9999; background: rgba(0, 0, 0, 0.65); color: #eee;
            font-family: monospace; font-size: 12px; padding: 10px 12px;
            border-radius: 6px; border: 1px solid rgba(255, 255, 255, 0.15);
            display: flex; flex-direction: column; gap: 10px; user-select: none;
            max-height: 80vh; overflow-y: auto; width: 190px;
        `;

        const title = document.createElement("div");
        title.textContent = "Dev Tools";
        title.style.cssText = `
            font-weight: 600; opacity: 0.85; letter-spacing: 0.04em;
            text-transform: uppercase; font-size: 10px;
        `;
        this.panel.appendChild(title);

        this.panel.appendChild(this._buildTeleportSection());
        this.panel.appendChild(this._buildEffectsSection());
        this.panel.appendChild(this._buildFreezeSection());
        this.panel.appendChild(this._buildPositionSection());
        this.panel.appendChild(this._buildCameraSection());
        this.panel.appendChild(this._buildHotspotSection());
        this.panel.appendChild(this._buildModeSection());
        this.panel.appendChild(this._buildTimeTrialSection());

        // Start hidden — Tab is the only thing that reveals it.
        this.panel.style.display = "none";

        document.body.appendChild(this.panel);
    }

    // Radians version of the manual rotation fields, for CameraController
    // to apply directly to camera.rotation while lookAtPlayer is off.
    getManualCameraRotationRadians() {
        return {
            x: this.manualCameraRotation.x * DEG2RAD,
            y: this.manualCameraRotation.y * DEG2RAD,
            z: this.manualCameraRotation.z * DEG2RAD,
        };
    }

    _sectionHeader(text) {
        const el = document.createElement("div");
        el.textContent = text;
        el.style.cssText = "opacity: 0.6; font-size: 10px; text-transform: uppercase; letter-spacing: 0.03em;";
        return el;
    }

    _button(label, onClick) {
        const btn = document.createElement("button");
        btn.textContent = label;
        btn.style.cssText = `
            font-family: monospace; font-size: 11px; color: #eee;
            background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.2);
            border-radius: 4px; padding: 4px 6px; cursor: pointer;
        `;
        btn.addEventListener("mouseenter", () => (btn.style.background = "rgba(255, 255, 255, 0.16)"));
        btn.addEventListener("mouseleave", () => (btn.style.background = "rgba(255, 255, 255, 0.08)"));
        btn.addEventListener("click", onClick);
        return btn;
    }

    _checkboxRow(id, label, onChange, checkedByDefault = false) {
        const row = document.createElement("label");
        row.style.cssText = "display: flex; align-items: center; gap: 6px; cursor: pointer;";

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.id = id;
        checkbox.checked = checkedByDefault;
        checkbox.addEventListener("change", () => onChange(checkbox.checked));

        const span = document.createElement("span");
        span.textContent = label;

        row.appendChild(checkbox);
        row.appendChild(span);
        return row;
    }

    // A small labeled numeric input, used for the manual camera
    // position/rotation fields. `onChange` fires on commit (Enter/blur or
    // spinner click), not on every keystroke, so a half-typed value never
    // gets applied.
    _numberInputRow(id, label, value, step, onChange) {
        const row = document.createElement("div");
        row.style.cssText = "display: flex; align-items: center; justify-content: space-between; gap: 6px;";

        const span = document.createElement("span");
        span.textContent = label;
        span.style.cssText = "opacity: 0.8; font-size: 11px;";

        const input = document.createElement("input");
        input.type = "number";
        input.id = id;
        input.value = value.toFixed(2);
        input.step = step;
        input.style.cssText = `
            font-family: monospace; font-size: 11px; color: #eee;
            background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.2);
            border-radius: 4px; padding: 3px 4px; width: 68px;
        `;
        input.addEventListener("change", () => {
            const v = parseFloat(input.value);
            if (!Number.isNaN(v)) onChange(v);
        });

        row.appendChild(span);
        row.appendChild(input);
        return { row, input };
    }
    _buildTeleportSection() {
        const wrap = document.createElement("div");
        wrap.style.cssText = "display: flex; flex-direction: column; gap: 4px;";

        wrap.appendChild(
            this._checkboxRow("canTeleportToHotspot", "canTeleportToHotspot", (checked) => {
                this.teleportEnabled = checked;
            })
        );

        const hint = document.createElement("div");
        hint.textContent = "Press 1-5 to teleport near a hotspot";
        hint.style.cssText = "opacity: 0.55; font-size: 10px;";
        wrap.appendChild(hint);

        return wrap;
    }

    _onKeyDown(e) {
        // Don't hijack keys while the user is typing into some other
        // input/textarea on the page.
        const target = e.target;
        if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;

        if (e.key === "Tab") {
            // Prevent the browser's default focus-shift behavior so Tab is
            // purely a devtools show/hide toggle.
            e.preventDefault();
            this._setVisible(!this.visible);
            return;
        }

        if (!this.teleportEnabled) return;
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

    // ── Grayscale-environment-on-hotspot toggle ──
    // The desaturate-everything-but-the-ball effect already exists in
    // BloomRenderer, driven every frame off HotspotSystem.isActive — this
    // just gates whether game.js is allowed to pass that through, so the
    // effect is opt-in instead of always firing on every hotspot entry.
    _buildEffectsSection() {
        const wrap = document.createElement("div");
        wrap.style.cssText = "display: flex; flex-direction: column; gap: 4px;";
        wrap.appendChild(this._sectionHeader("Effects"));

        // Bypasses hotspot state entirely — forces the render effect on/off
        // directly, so you can confirm BloomRenderer's grayscale pass works
        // at all without needing to be inside a hotspot trigger.
        wrap.appendChild(
            this._checkboxRow("grayscalePreview", "previewGrayscale", (checked) => {
                this.grayscalePreview = checked;
                if (this.bloomRenderer) this.bloomRenderer.setHotspotActive(checked);
            })
        );

        const previewHint = document.createElement("div");
        previewHint.textContent = "Forces the effect on now, ignoring hotspots";
        previewHint.style.cssText = "opacity: 0.55; font-size: 10px;";
        wrap.appendChild(previewHint);

        return wrap;
    }

    // ── Freeze movement ──
    // Uses PlayerController's existing hard-freeze switch (the same one
    // GameModeManager uses while a result popup is up): horizontal
    // velocity/input is pinned to 0 every frame. Gravity/vertical velocity
    // is untouched, so a frozen ball still falls if there's no ground under
    // it — this locks steering, it doesn't clip through geometry.
    _buildFreezeSection() {
        const wrap = document.createElement("div");
        wrap.appendChild(
            this._checkboxRow("freezePlayer", "freezePlayer", (checked) => {
                this.player.setFrozen(checked);
            })
        );
        return wrap;
    }

    // ── Live ball position readout ──
    _buildPositionSection() {
        const wrap = document.createElement("div");
        wrap.style.cssText = "display: flex; flex-direction: column; gap: 4px;";
        wrap.appendChild(this._sectionHeader("Position"));

        this.positionReadout = document.createElement("div");
        this.positionReadout.style.cssText = "font-size: 11px; opacity: 0.9;";
        this.positionReadout.textContent = "x: 0.00  y: 0.00  z: 0.00";
        wrap.appendChild(this.positionReadout);

        return wrap;
    }

    // ── Camera Free Roam: Blender-style MMB orbit ──
    // All of this only ever runs while lookAtPlayer is off (the Free Roam
    // checkbox can't even be checked otherwise — see _buildCameraSection),
    // so it never fights with the normal follow camera.

    // Seeds `eye` and the look-direction angles from wherever the camera
    // actually is right now, so flipping Free Roam on never snaps the view
    // anywhere — the very first frame reproduces the exact current
    // position and (barring roll, which a level look-direction can't
    // represent) the exact current facing.
    _initOrbitFromCamera() {
        if (!this.camera) return;
        const orbit = this._orbit;

        orbit.eye.copy(this.camera.position);

        const forward = new THREE.Vector3();
        this.camera.getWorldDirection(forward);
        orbit.theta = Math.atan2(forward.x, forward.z);
        orbit.phi = THREE.MathUtils.clamp(
            Math.acos(THREE.MathUtils.clamp(forward.y, -1, 1)),
            ORBIT_MIN_PHI,
            ORBIT_MAX_PHI
        );
    }

    // Converts the current eye position + look-direction angles into
    // manualCameraPosition / manualCameraRotation (degrees) — the same
    // fields the plain manual inputs write to — then pushes the new values
    // into the number inputs so the panel never shows stale numbers while
    // orbiting. Position always comes straight from `eye`: rotating never
    // touches it, so the camera only ever moves via explicit pan/zoom.
    _applyOrbit() {
        const orbit = this._orbit;
        const sinPhi = Math.sin(orbit.phi);
        this._orbitDirection.set(
            sinPhi * Math.sin(orbit.theta),
            Math.cos(orbit.phi),
            sinPhi * Math.cos(orbit.theta)
        );

        this.manualCameraPosition.x = orbit.eye.x;
        this.manualCameraPosition.y = orbit.eye.y;
        this.manualCameraPosition.z = orbit.eye.z;

        this._orbitDummy.position.copy(orbit.eye);
        this._orbitDummy.up.set(0, 1, 0);
        this._orbitLookTarget.copy(orbit.eye).add(this._orbitDirection);
        this._orbitDummy.lookAt(this._orbitLookTarget);

        this.manualCameraRotation.x = RAD2DEG * this._orbitDummy.rotation.x;
        this.manualCameraRotation.y = RAD2DEG * this._orbitDummy.rotation.y;
        this.manualCameraRotation.z = RAD2DEG * this._orbitDummy.rotation.z;

        this._syncCameraInputs();
    }

    // Slides `eye` sideways/up-down along the camera's own current
    // right/up axes (from the last-applied orbit orientation). Rotation
    // (theta/phi) is untouched, so this only ever translates the camera.
    _panOrbit(dx, dy) {
        const orbit = this._orbit;
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this._orbitDummy.quaternion);
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this._orbitDummy.quaternion);
        orbit.eye.addScaledVector(right, -dx * ORBIT_PAN_SPEED);
        orbit.eye.addScaledVector(up, dy * ORBIT_PAN_SPEED);
    }

    // Moves `eye` forward/back along the current look direction (a dolly,
    // not a distance-to-target change — there is no external target).
    // Positive `amount` moves toward where the camera is looking.
    _dollyOrbit(amount) {
        const orbit = this._orbit;
        const sinPhi = Math.sin(orbit.phi);
        this._orbitDirection.set(
            sinPhi * Math.sin(orbit.theta),
            Math.cos(orbit.phi),
            sinPhi * Math.cos(orbit.theta)
        );
        orbit.eye.addScaledVector(this._orbitDirection, amount);
    }

    _setFreeRoamEnabled(checked) {
        this.freeRoamEnabled = checked;
        if (checked) {
            this._initOrbitFromCamera();
            this._applyOrbit();
        } else {
            this._orbit.dragging = null;
        }
    }

    _setFreeRoamRowVisible(visible) {
        if (this.freeRoamRow) this.freeRoamRow.style.display = visible ? "flex" : "none";
        if (this.freeRoamHint) this.freeRoamHint.style.display = visible ? "block" : "none";
    }

    _onMouseDown(e) {
        if (!this.freeRoamEnabled) return;
        if (e.button !== 1) return; // middle mouse button only
        if (this.panel.contains(e.target)) return; // don't hijack panel scrolling/clicks

        // Stop the browser's native middle-click autoscroll from kicking in.
        e.preventDefault();

        const orbit = this._orbit;
        orbit.dragging = e.ctrlKey ? "zoom" : e.shiftKey ? "pan" : "orbit";
        orbit.lastX = e.clientX;
        orbit.lastY = e.clientY;
    }

    _onMouseMove(e) {
        const orbit = this._orbit;
        if (!orbit.dragging) return;

        const dx = e.clientX - orbit.lastX;
        const dy = e.clientY - orbit.lastY;
        orbit.lastX = e.clientX;
        orbit.lastY = e.clientY;

        if (orbit.dragging === "orbit") {
            orbit.theta -= dx * ORBIT_ROTATE_SPEED;
            orbit.phi = THREE.MathUtils.clamp(orbit.phi - dy * ORBIT_ROTATE_SPEED, ORBIT_MIN_PHI, ORBIT_MAX_PHI);
        } else if (orbit.dragging === "pan") {
            this._panOrbit(dx, dy);
        } else if (orbit.dragging === "zoom") {
            orbit.radius = THREE.MathUtils.clamp(
                orbit.radius + dy * ORBIT_DRAG_ZOOM_SPEED,
                ORBIT_MIN_RADIUS,
                ORBIT_MAX_RADIUS
            );
        }

        this._applyOrbit();
    }

    _onMouseUp(e) {
        if (e.button !== 1) return;
        this._orbit.dragging = null;
    }

    _onWheel(e) {
        if (!this.freeRoamEnabled) return;
        e.preventDefault();

        const orbit = this._orbit;
        orbit.radius = THREE.MathUtils.clamp(
            orbit.radius + e.deltaY * ORBIT_WHEEL_ZOOM_SPEED,
            ORBIT_MIN_RADIUS,
            ORBIT_MAX_RADIUS
        );
        this._applyOrbit();
    }

    // ── Camera: live position/rotation readout, manual override fields,
    // and the lookAtPlayer toggle ──
    // While lookAtPlayer is on (default), CameraController runs its normal
    // follow-the-ball logic every frame same as always, and the fields
    // below just mirror whatever the camera's actual live transform is.
    // Switching lookAtPlayer off tells CameraController to stop touching
    // the camera entirely and instead apply manualCameraPosition /
    // manualCameraRotation directly — that's what "look wherever you
    // like" means here: drive the camera by hand through these fields
    // instead of the game's own follow logic.
    _buildCameraSection() {
        const wrap = document.createElement("div");
        wrap.style.cssText = "display: flex; flex-direction: column; gap: 4px;";
        wrap.appendChild(this._sectionHeader("Camera"));

        this.cameraPositionReadout = document.createElement("div");
        this.cameraPositionReadout.style.cssText = "font-size: 11px; opacity: 0.9;";
        this.cameraPositionReadout.textContent = "x: 0.00  y: 0.00  z: 0.00";
        wrap.appendChild(this.cameraPositionReadout);

        this.cameraRotationReadout = document.createElement("div");
        this.cameraRotationReadout.style.cssText = "font-size: 11px; opacity: 0.9;";
        this.cameraRotationReadout.textContent = "x: 0.00°  y: 0.00°  z: 0.00°";
        wrap.appendChild(this.cameraRotationReadout);

        wrap.appendChild(
            this._checkboxRow(
                "lookAtPlayer",
                "lookAtPlayer",
                (checked) => {
                    this.lookAtPlayer = checked;
                    // Re-seed the manual fields from the camera's current
                    // transform right as manual control kicks in, so
                    // turning lookAtPlayer off never causes a jump — the
                    // camera stays exactly where it was until the user
                    // actually edits a field.
                    if (!checked && this.camera) {
                        this.manualCameraPosition.x = this.camera.position.x;
                        this.manualCameraPosition.y = this.camera.position.y;
                        this.manualCameraPosition.z = this.camera.position.z;
                        this.manualCameraRotation.x = RAD2DEG * this.camera.rotation.x;
                        this.manualCameraRotation.y = RAD2DEG * this.camera.rotation.y;
                        this.manualCameraRotation.z = RAD2DEG * this.camera.rotation.z;
                        this._syncCameraInputs();
                    }

                    // Camera Free Roam only makes sense while lookAtPlayer
                    // is off — its checkbox is hidden the rest of the time.
                    // Re-enabling lookAtPlayer forces Free Roam off (and
                    // its box unchecked) too, rather than leaving it
                    // silently armed for the next time the row reappears.
                    this._setFreeRoamRowVisible(!checked);
                    if (checked) {
                        this._setFreeRoamEnabled(false);
                        if (this.freeRoamCheckbox) this.freeRoamCheckbox.checked = false;
                    }
                },
                true // ON by default
            )
        );

        wrap.appendChild(
            (() => {
                const row = this._checkboxRow(
                    "cameraFreeRoam",
                    "Camera Free Roam",
                    (checked) => this._setFreeRoamEnabled(checked),
                    false // OFF by default
                );
                row.style.display = "none"; // shown only while lookAtPlayer is off
                this.freeRoamRow = row;
                this.freeRoamCheckbox = row.querySelector("input");
                return row;
            })()
        );

        const freeRoamHint = document.createElement("div");
        freeRoamHint.textContent = "MMB orbit \u00b7 Shift+MMB pan \u00b7 Scroll/Ctrl+MMB zoom";
        freeRoamHint.style.cssText = "opacity: 0.55; font-size: 10px; display: none;";
        this.freeRoamHint = freeRoamHint;
        wrap.appendChild(freeRoamHint);

        const posHeader = document.createElement("div");
        posHeader.textContent = "Position";
        posHeader.style.cssText = "opacity: 0.55; font-size: 10px; margin-top: 2px;";
        wrap.appendChild(posHeader);

        this.cameraPosInputs = {};
        for (const axis of ["x", "y", "z"]) {
            const { input } = this._numberInputRow(
                `cameraPos${axis.toUpperCase()}`,
                axis,
                this.manualCameraPosition[axis],
                0.1,
                (v) => {
                    this.manualCameraPosition[axis] = v;
                }
            );
            this.cameraPosInputs[axis] = input;
            wrap.appendChild(input.parentElement);
        }

        const rotHeader = document.createElement("div");
        rotHeader.textContent = "Rotation (deg)";
        rotHeader.style.cssText = "opacity: 0.55; font-size: 10px; margin-top: 2px;";
        wrap.appendChild(rotHeader);

        this.cameraRotInputs = {};
        for (const axis of ["x", "y", "z"]) {
            const { input } = this._numberInputRow(
                `cameraRot${axis.toUpperCase()}`,
                axis,
                this.manualCameraRotation[axis],
                1,
                (v) => {
                    this.manualCameraRotation[axis] = v;
                }
            );
            this.cameraRotInputs[axis] = input;
            wrap.appendChild(input.parentElement);
        }

        const hint = document.createElement("div");
        hint.textContent = "Fields only drive the camera while lookAtPlayer is off";
        hint.style.cssText = "opacity: 0.55; font-size: 10px;";
        wrap.appendChild(hint);

        return wrap;
    }

    // Pushes manualCameraPosition/Rotation into the number inputs. Used
    // right after re-seeding them from the live camera (on the
    // lookAtPlayer off-toggle) so the fields don't show stale values.
    _syncCameraInputs() {
        for (const axis of ["x", "y", "z"]) {
            this.cameraPosInputs[axis].value = this.manualCameraPosition[axis].toFixed(2);
            this.cameraRotInputs[axis].value = this.manualCameraRotation[axis].toFixed(2);
        }
    }

    // ── Hotspot controls: hide/restore all, force-trigger a popup ──
    _buildHotspotSection() {
        const wrap = document.createElement("div");
        wrap.style.cssText = "display: flex; flex-direction: column; gap: 4px;";
        wrap.appendChild(this._sectionHeader("Hotspots"));

        const hideRestoreRow = document.createElement("div");
        hideRestoreRow.style.cssText = "display: flex; gap: 4px;";
        hideRestoreRow.appendChild(
            this._button("Hide all", () => {
                // hideAllExcept(null) — nothing matches null, so every
                // hotspot's `hidden` flag ends up true.
                this.hotspotSystem.hideAllExcept(null);
            })
        );
        hideRestoreRow.appendChild(this._button("Restore all", () => this.hotspotSystem.restoreAll()));
        wrap.appendChild(hideRestoreRow);

        const triggerRow = document.createElement("div");
        triggerRow.style.cssText = "display: flex; flex-wrap: wrap; gap: 4px;";
        for (let i = 1; i <= 5; i++) {
            triggerRow.appendChild(
                this._button(String(i), () => this.hotspotSystem.triggerHotspot(`Hotspot_${i}`))
            );
        }
        triggerRow.appendChild(this._button("Close", () => this.hotspotSystem.closePopup()));
        wrap.appendChild(triggerRow);

        const hint = document.createElement("div");
        hint.textContent = "Numbers force-trigger that hotspot's popup";
        hint.style.cssText = "opacity: 0.55; font-size: 10px;";
        wrap.appendChild(hint);

        return wrap;
    }

    // ── Game mode switcher ──
    _buildModeSection() {
        const wrap = document.createElement("div");
        wrap.style.cssText = "display: flex; flex-direction: column; gap: 4px;";
        wrap.appendChild(this._sectionHeader("Game mode"));

        const row = document.createElement("div");
        row.style.cssText = "display: flex; flex-direction: column; gap: 4px;";
        for (const { mode, label } of MODE_BUTTONS) {
            row.appendChild(this._button(label, () => this.gameModeManager.selectMode(mode)));
        }
        wrap.appendChild(row);

        return wrap;
    }

    // ── Time Trial cheats ──
    _buildTimeTrialSection() {
        const wrap = document.createElement("div");
        wrap.style.cssText = "display: flex; flex-direction: column; gap: 4px;";
        wrap.appendChild(this._sectionHeader("Time Trial"));

        const row = document.createElement("div");
        row.style.cssText = "display: flex; gap: 4px;";
        row.appendChild(this._button(`+${DEV_ADD_TIME_SECONDS}s`, () => this.gameModeManager.addTime(DEV_ADD_TIME_SECONDS)));
        row.appendChild(this._button("Collect orbs", () => this.gameModeManager.collectAllOrbs()));
        wrap.appendChild(row);

        const hint = document.createElement("div");
        hint.textContent = "Only applies during an active Time Trial run";
        hint.style.cssText = "opacity: 0.55; font-size: 10px;";
        wrap.appendChild(hint);

        return wrap;
    }
}