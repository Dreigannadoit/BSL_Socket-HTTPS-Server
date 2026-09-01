import * as THREE from "three";
import {
    FOG_START_DEPTH,
    FOG_FULL_DEPTH,
    FOG_LAYER_COUNT,
    FOG_TOP_OPACITY,
    FOG_MAX_OPACITY,
    FOG_FALLOFF_POWER,
    FOG_COLOR,
    FOG_PLANE_SIZE,
    isFogFollowPlayer,
} from "./config.js";

// Height-based fog band positioned relative to the player. By default
// (isFogFollowPlayer = false) it's anchored once, via init(), to the
// player's spawn height and never moves again for the rest of the round —
// so it reads as a fixed layer of murk sitting in the depths, and climbing
// to a higher platform doesn't drag it up too. Set isFogFollowPlayer to
// true in config.js to instead have the whole band continuously follow the
// player's current height every frame.
//
// Either way, opacity ramps from a light haze at FOG_START_DEPTH below the
// anchor to fully opaque at FOG_FULL_DEPTH below it. A single flat plane
// can't do this — it's one opacity everywhere — so instead this stacks
// several horizontal planes spanning the depth band, each denser than the
// one above it. The planes keep normal depth testing (just no depth
// writing, like any transparent object), so solid ground between the
// player and a plane still occludes it as usual — the fog only becomes
// visible where there's genuinely open space for it to fill.
export class PlayerFog {
    constructor(scene) {
        this.layers = [];

        for (let i = 0; i < FOG_LAYER_COUNT; i++) {
            const t = i / (FOG_LAYER_COUNT - 1); // 0 at the start depth, 1 at the full-fog depth
            const opacity = THREE.MathUtils.lerp(FOG_TOP_OPACITY, FOG_MAX_OPACITY, Math.pow(t, FOG_FALLOFF_POWER));

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

    // Positions every layer under the given point once — call this with
    // the player's spawn position after the level loads. This is what
    // fixes the band's height for the rest of the round when
    // isFogFollowPlayer is false.
    init(position) {
        this._reposition(position);
    }

    // Called every frame from the main loop. Only actually moves the band
    // when isFogFollowPlayer is true; otherwise the band stays exactly
    // where init() left it.
    update(playerPosition) {
        if (!isFogFollowPlayer) return;
        this._reposition(playerPosition);
    }

    _reposition(position) {
        for (const { plane, t } of this.layers) {
            const depth = THREE.MathUtils.lerp(FOG_START_DEPTH, FOG_FULL_DEPTH, t);
            plane.position.set(position.x, position.y - depth, position.z);
        }
    }
}