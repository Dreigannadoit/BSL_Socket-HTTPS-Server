import * as THREE from "three";
import {
    BALL_RADIUS,
    BLOOM_LAYER,
    ROUTE_TRIGGER_CONTENT,
    ROUTE_TRIGGER_GLOW_COLOR,
    ROUTE_TRIGGER_GLOW_MIN_INTENSITY,
    ROUTE_TRIGGER_GLOW_MAX_INTENSITY,
    ROUTE_TRIGGER_POPUP_HEIGHT,
    ROUTE_TRIGGER_EXIT_BUFFER,
} from "./config.js";

// Owns every trigger authored under the level GLB's "RouteBasedTriggers"
// group: rolling onto one shows a "Press Enter for <label>" billboard (via
// `ui`, a RouteTriggerBillboard) and, if the player presses Enter while
// still standing on it, navigates the whole page to that trigger's URL.
//
// Detection is distance-based with "nearest wins" (same proven pattern as
// HotspotSystem), NOT box-containment — route triggers are commonly
// authored as a tight signpost cluster (this level's About/Github/LinkedIn
// markers sit only ~1.5-2m apart), and overlapping bounding boxes checked
// in a fixed order can let one trigger's box "shadow" a neighbor's,
// depending on which direction the ball approaches from. Picking whichever
// registered trigger's own center the ball is actually closest to (among
// those within their own enter radius) sidesteps that ambiguity entirely.
//
// The prompt itself never touches player movement — no freezing, no speed
// changes while just standing near a trigger. Confirming (Enter) is a
// one-way trip out, though: `onNavigate` (see main.js) plays a reverse
// spawn-beam exit and freezes the player for that brief moment before the
// page actually navigates — see PlayerExit.
export class RouteTriggerSystem {
    constructor({ scene, ui, onNavigate }) {
        this.scene = scene;
        this.ui = ui;
        this.onNavigate = onNavigate;
        this.triggers = []; // { name, node, worldPosition, popupAnchor, label, url, glowMaterials, enterRadius, exitRadius }
        this.activeTrigger = null; // currently-inside trigger, or null
        // Set the instant a trigger is confirmed — once true, update()
        // becomes a no-op for the rest of the page's life. Without this,
        // the ball sitting frozen-but-still-inside a trigger's enter
        // radius during the exit animation would immediately re-enter
        // (and re-show/re-arm) the very trigger just confirmed, since
        // nothing else here knows the page is on its way out.
        this.locked = false;
    }

    // Called once after the level loads, with the "RouteBasedTriggers" root
    // node (or null if the level has none). Registers every direct child
    // whose name has a matching ROUTE_TRIGGER_CONTENT entry; anything else
    // under the node is ignored so unrelated helper nodes don't need
    // special-casing (same convention as HotspotSystem.setup).
    setup(routeTriggersRoot) {
        if (!routeTriggersRoot) return;

        for (const child of routeTriggersRoot.children) {
            const content = ROUTE_TRIGGER_CONTENT[child.name];
            if (!content) continue;
            this.triggers.push(this._createTrigger(child, content));
        }
    }

    // Reads the trigger's authored world position + footprint (same
    // Box3-from-geometry pattern EndTriggerEffect uses for its own ring
    // radius) to derive an enter/exit radius, then swaps every mesh under
    // the node onto the same emissive/bloom material trick HotspotSystem/
    // MovableObjectResetTrigger use, tinted yellow instead of GLOW_COLOR's
    // blue.
    _createTrigger(node, content) {
        node.visible = true;

        const box = new THREE.Box3().setFromObject(node);
        const size = new THREE.Vector3();
        box.getSize(size);
        const footprintRadius = Math.max(size.x, size.z) / 2;

        const worldPosition = new THREE.Vector3();
        node.getWorldPosition(worldPosition);

        const popupAnchor = worldPosition.clone();
        popupAnchor.y += ROUTE_TRIGGER_POPUP_HEIGHT;

        const enterRadius = footprintRadius + BALL_RADIUS;
        const exitRadius = enterRadius + ROUTE_TRIGGER_EXIT_BUFFER;

        const meshes = [];
        if (node.isMesh) meshes.push(node);
        node.traverse((child) => {
            if (child.isMesh && child !== node) meshes.push(child);
        });

        const glowMaterials = [];
        for (const mesh of meshes) {
            const mat = new THREE.MeshStandardMaterial({
                color: ROUTE_TRIGGER_GLOW_COLOR,
                emissive: ROUTE_TRIGGER_GLOW_COLOR,
                emissiveIntensity: ROUTE_TRIGGER_GLOW_MIN_INTENSITY, // overwritten every frame by update()
                roughness: 0.3,
                metalness: 0,
                toneMapped: false, // let emissive push past 1.0 and actually read as "hot"
            });
            mesh.material = mat;
            mesh.castShadow = false;
            mesh.receiveShadow = false;
            mesh.layers.enable(BLOOM_LAYER); // feeds BloomRenderer's isolated pass
            glowMaterials.push(mat);
        }

        return {
            name: node.name,
            node,
            worldPosition,
            popupAnchor,
            label: content.label,
            url: content.url,
            glowMaterials,
            enterRadius,
            exitRadius,
        };
    }

    // Every frame from the main loop, with the ball's live world position:
    // pulses the glow (a much gentler curve than GlowPath/HotspotSystem's
    // shared one — see ROUTE_TRIGGER_GLOW_MIN/MAX_INTENSITY's comment in
    // config.js) and handles both the enter and exit edges, one trigger
    // active at a time.
    update(ballPosition, elapsed) {
        if (this.triggers.length === 0 || this.locked) return;

        const pulse = 0.5 + Math.sin(elapsed * 2.2) * 0.5; // 0 -> 1
        const intensity = ROUTE_TRIGGER_GLOW_MIN_INTENSITY
            + pulse * (ROUTE_TRIGGER_GLOW_MAX_INTENSITY - ROUTE_TRIGGER_GLOW_MIN_INTENSITY);
        for (const trigger of this.triggers) {
            for (const mat of trigger.glowMaterials) mat.emissiveIntensity = intensity;
        }

        if (this.activeTrigger) {
            const dist = ballPosition.distanceTo(this.activeTrigger.worldPosition);
            if (dist > this.activeTrigger.exitRadius) {
                this._exit();
            }
        }

        if (!this.activeTrigger) {
            // Among every trigger the ball is currently within range of,
            // enter whichever one's center it's actually closest to —
            // see the class comment for why "nearest wins" beats a fixed
            // iteration order for a tightly clustered signpost like this.
            let nearest = null;
            let nearestDist = Infinity;
            for (const trigger of this.triggers) {
                const dist = ballPosition.distanceTo(trigger.worldPosition);
                if (dist <= trigger.enterRadius && dist < nearestDist) {
                    nearest = trigger;
                    nearestDist = dist;
                }
            }
            if (nearest) this._enter(nearest);
        }
    }

    _enter(trigger) {
        this.activeTrigger = trigger;
        // Deliberately NOT freezing the player (same reasoning as
        // MovableObjectSystem._openConfirm) — the prompt just floats in on
        // top of normal play; the player can keep rolling, drive away,
        // come back, whatever, until they press Enter or roll off.
        this.ui.show(trigger.popupAnchor, trigger.label, {
            onConfirm: () => this._navigate(trigger),
        });
    }

    _exit() {
        this.ui.hide();
        this.activeTrigger = null;
    }

    _navigate(trigger) {
        if (this.locked) return;
        this.locked = true;
        this.ui.hide();
        this.activeTrigger = null;

        const url = typeof trigger.url === "function" ? trigger.url() : trigger.url;
        if (this.onNavigate) {
            this.onNavigate(url);
        } else {
            window.location.href = url;
        }
    }
}
