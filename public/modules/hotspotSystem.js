import * as THREE from "three";
import { HOTSPOT_TRIGGER_RADIUS, GLOW_COLOR, BLOOM_LAYER } from "./config.js";

// Maps a hotspot's world node name (as authored in the level GLB, under a
// "Hotspots" root — same pattern as "CollisionShapes"/"GlowPath") to the
// popup content shown when the player rolls over it. `className` lets each
// hotspot use a completely different layout, not just different text — see
// the .hotspot-content-1 / .hotspot-content-2 rules in index.html. Add an
// entry here for every new "Hotspot_N" node you author in the level.
const HOTSPOT_CONTENT = {
    Hotspot_1: {
        className: "hotspot-content-1",
        render: () => `<div>Content 1</div>`,
    },
    Hotspot_2: {
        className: "hotspot-content-2",
        render: () => `<div>Content 2</div>`,
    },
};

// Detects when the ball enters/exits a level-authored hotspot trigger and
// owns the popup DOM element that displays each hotspot's content. Movement
// itself isn't touched here — on entry it just calls the optional onEnter
// callback (typically player.stick(...)), leaving PlayerController to own
// the actual stuck-timer/wobble-to-a-stop effect.
//
// Every registered hotspot node also gets the same pulsating blue-neon
// bloom treatment as GlowPath (same emissive material setup, same BLOOM_LAYER
// flag, same breathing-pulse curve), so the markers themselves are visible
// in the level as glowing beacons rather than invisible trigger volumes.
export class HotspotSystem {
    constructor(popupEl, onEnter) {
        this.popupEl = popupEl;
        this.onEnter = onEnter;
        this.hotspots = []; // { name, position, content }
        this.activeHotspot = null; // currently-inside hotspot, or null
        this.glowMaterials = []; // pulsed each frame, same pattern as GlowPath
    }

    // Called once after the level loads, with the "Hotspots" root node (or
    // null if the level has none). Registers every child whose name has a
    // matching HOTSPOT_CONTENT entry; anything else under the node is
    // ignored so unrelated helper nodes don't need special-casing.
    setup(hotspotsRoot) {
        if (!hotspotsRoot) return;

        hotspotsRoot.traverse((child) => {
            if (child === hotspotsRoot) return;
            const content = HOTSPOT_CONTENT[child.name];
            if (!content) return;

            const position = new THREE.Vector3();
            child.getWorldPosition(position);
            this.hotspots.push({ name: child.name, position, content });

            this._setupGlow(child);
        });
    }

    // Swaps every mesh under `node` (or node itself, if it's already a
    // mesh) onto the same emissive/bloom material GlowPath uses, so the
    // hotspot marker reads as the identical blue neon glow.
    _setupGlow(node) {
        const meshes = [];
        if (node.isMesh) {
            meshes.push(node);
        } else {
            node.traverse((child) => {
                if (child.isMesh) meshes.push(child);
            });
        }

        for (const mesh of meshes) {
            const mat = new THREE.MeshStandardMaterial({
                color: GLOW_COLOR,
                emissive: GLOW_COLOR,
                emissiveIntensity: 1.6, // overwritten every frame by updateGlow()
                roughness: 0.3,
                metalness: 0,
                toneMapped: false, // let emissive push past 1.0 and actually read as "hot"
            });
            mesh.material = mat;
            mesh.castShadow = false;
            mesh.receiveShadow = false;
            mesh.layers.enable(BLOOM_LAYER); // feeds BloomRenderer's isolated pass
            this.glowMaterials.push(mat);
        }
    }

    // Gentle breathing pulse — same curve/range as GlowPath.update() — so
    // hotspot markers pulse in lockstep with the neon path rather than out
    // of sync with a different rhythm. Call every frame regardless of
    // whether any hotspot is currently active; the markers glow always.
    updateGlow(elapsed) {
        const pulse = 0.5 + Math.sin(elapsed * 2.2) * 0.5; // 0 -> 1
        const intensity = 2.2 + pulse * 1.2; // ~2.2–3.4, matches GlowPath's "core" role
        for (const mat of this.glowMaterials) {
            mat.emissiveIntensity = intensity;
        }
    }

    // Called every frame with the ball's live world position. Handles both
    // the enter and exit edges; only one hotspot can be active at a time.
    update(ballPosition) {
        if (this.activeHotspot) {
            const dist = ballPosition.distanceTo(this.activeHotspot.position);
            if (dist > HOTSPOT_TRIGGER_RADIUS) {
                this._exit();
            }
        }

        if (!this.activeHotspot) {
            for (const hotspot of this.hotspots) {
                if (ballPosition.distanceTo(hotspot.position) <= HOTSPOT_TRIGGER_RADIUS) {
                    this._enter(hotspot);
                    break;
                }
            }
        }
    }

    _enter(hotspot) {
        this.activeHotspot = hotspot;
        this.popupEl.innerHTML = hotspot.content.render();
        // className overwrites any previous per-hotspot layout class
        // (including "visible") in one go...
        this.popupEl.className = hotspot.content.className;
        // ...so force a reflow before re-adding "visible", otherwise the
        // browser can coalesce both class changes into a single paint and
        // the CSS fade-in transition never gets a chance to run.
        void this.popupEl.offsetWidth;
        this.popupEl.classList.add("visible");

        if (this.onEnter) this.onEnter(hotspot);
    }

    _exit() {
        this.activeHotspot = null;
        this.popupEl.classList.remove("visible");
    }

    get isActive() {
        return this.activeHotspot !== null;
    }
}