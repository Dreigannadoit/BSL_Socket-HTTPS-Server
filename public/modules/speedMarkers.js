import * as THREE from "three";
import {
    SPEED_MARKER_HEIGHT,
    SPEED_MARKER_RADIUS,
    SPEED_MARKER_SIDE_OFFSET,
    SPEED_MARKER_STRIDE,
} from "./config.js";

// Procedural, purely-decorative roadside pylons spaced along the level's
// existing "GlowPath" marker node — no new authored asset needed. Their
// only job is parallax: objects close to the camera sweeping past read as
// "fast" far more than raw ball velocity does, which is why this exists
// alongside CameraController's speed FOV/shake and AudioManager's speed
// pitch-shift (see config.js's "Speed feel" section for all three).
//
// NOTE: side-offset placement is a straight perpendicular-to-path guess
// with no awareness of the level's actual corridor width or nearby wall
// geometry, and this couldn't be visually verified in this environment —
// SPEED_MARKER_SIDE_OFFSET/STRIDE in config.js will likely need tuning
// (or per-section exceptions) once you've actually run it and can see
// whether markers clip into walls anywhere.
function makeStripeTexture() {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#161616";
    ctx.fillRect(0, 0, 64, 64);
    ctx.fillStyle = "#ffcc00";
    // Diagonal hazard stripes, wrapping so they read as "caution" without
    // needing an actual image asset.
    for (let x = -64; x < 128; x += 16) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x + 8, 0);
        ctx.lineTo(x + 8 - 64, 64);
        ctx.lineTo(x - 64, 64);
        ctx.closePath();
        ctx.fill();
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(1, 3);
    if ("colorSpace" in texture) texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}

export class SpeedMarkers {
    constructor() {
        this.group = new THREE.Group();
        this.group.visible = false; // GameModeManager toggles this per mode
    }

    // glowRoot: the same "GlowPath" node levelLoader already hands to
    // GlowPath.setup() — reused here purely for its authored positions,
    // not touched or mutated.
    setup(scene, glowRoot) {
        if (!glowRoot) return;

        const anchors = [];
        glowRoot.traverse((child) => {
            if (child.isMesh) {
                const pos = new THREE.Vector3();
                child.getWorldPosition(pos);
                anchors.push(pos);
            }
        });
        if (anchors.length < 2) return;

        const texture = makeStripeTexture();
        const material = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.6, metalness: 0 });
        const geometry = new THREE.CylinderGeometry(
            SPEED_MARKER_RADIUS,
            SPEED_MARKER_RADIUS,
            SPEED_MARKER_HEIGHT,
            8
        );
        geometry.translate(0, SPEED_MARKER_HEIGHT / 2, 0); // pivot at the base, not the center

        for (let i = 0; i < anchors.length; i += SPEED_MARKER_STRIDE) {
            const p = anchors[i];
            const next = anchors[Math.min(i + 1, anchors.length - 1)];
            const dir = next.clone().sub(p);
            dir.y = 0;
            if (dir.lengthSq() < 1e-6) continue; // coincident points — no direction to derive a perpendicular from
            dir.normalize();
            const perp = new THREE.Vector3(-dir.z, 0, dir.x); // rotate 90° in the XZ plane

            for (const side of [-1, 1]) {
                const mesh = new THREE.Mesh(geometry, material);
                mesh.position.copy(p).addScaledVector(perp, SPEED_MARKER_SIDE_OFFSET * side);
                mesh.castShadow = false;
                mesh.receiveShadow = false;
                this.group.add(mesh);
            }
        }

        scene.add(this.group);
    }

    setVisible(visible) {
        this.group.visible = visible;
    }
}
