import * as THREE from "three";
import {
    FOG_START_DEPTH,
    FOG_FULL_DEPTH,
    FOG_LAYER_COUNT,
    FOG_TOP_OPACITY,
    FOG_FALLOFF_POWER,
    FOG_COLOR,
    FOG_PLANE_SIZE,
} from "./config.js";

// Height-based fog that tracks the player instead of a fixed level marker:
// opacity ramps from a light haze at FOG_START_DEPTH below the ball to
// fully opaque at FOG_FULL_DEPTH below it, so looking down into ANY pit or
// gap gets progressively murkier the deeper it goes, until the bottom is
// completely hidden — no matter where on the map that pit is.
//
// A single flat plane can't do this — it's one opacity everywhere — so
// instead this stacks several horizontal planes spanning the depth band,
// each denser than the one above it. The planes keep normal depth testing
// (just no depth writing, like any transparent object), so solid ground
// between the player and a plane still occludes it as usual — the fog only
// becomes visible where there's genuinely open space beneath the player for
// it to fill.
export class PlayerFog {
    constructor(scene) {
        this.layers = [];

        for (let i = 0; i < FOG_LAYER_COUNT; i++) {
            const t = i / (FOG_LAYER_COUNT - 1); // 0 at the start depth, 1 at the full-fog depth
            const opacity = THREE.MathUtils.lerp(FOG_TOP_OPACITY, 1, Math.pow(t, FOG_FALLOFF_POWER));

            const geo = new THREE.PlaneGeometry(FOG_PLANE_SIZE, FOG_PLANE_SIZE);
            const mat = new THREE.MeshBasicMaterial({
                color: FOG_COLOR,
                transparent: true,
                opacity,
                depthWrite: false,
            });
            const plane = new THREE.Mesh(geo, mat);
            plane.rotation.x = -Math.PI / 2;
            // Transparent objects don't write depth, so draw order among
            // them isn't guaranteed by distance alone — force top-to-bottom
            // order explicitly so the denser deeper layers always
            // composite on top.
            plane.renderOrder = i;
            scene.add(plane);

            this.layers.push({ plane, t });
        }
    }

    // Re-centers every layer under the player's current position each
    // frame, so the whole depth band rides along with the ball.
    update(playerPosition) {
        for (const { plane, t } of this.layers) {
            const depth = THREE.MathUtils.lerp(FOG_START_DEPTH, FOG_FULL_DEPTH, t);
            plane.position.set(playerPosition.x, playerPosition.y - depth, playerPosition.z);
        }
    }
}