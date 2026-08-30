import * as THREE from "three";
import { FOG_LAYER_COUNT, FOG_TOP_OPACITY, FOG_FALLOFF_POWER, FOG_COLOR } from "./config.js";

// Height-based fog: opacity ramps from a light haze at the top of the given
// marker node's bounding box to fully opaque at its bottom, so looking down
// into a pit gets progressively murkier until the floor is completely
// hidden. A single flat plane can't do this — it's one opacity everywhere —
// so instead this stacks several horizontal planes spanning the node's full
// vertical extent, each denser than the one above it. Viewed from above, the
// overlapping semi-transparent layers accumulate into a visual density
// gradient, and the fully-opaque bottom layer blocks the view outright.
export function setupFogFromNode(node, scene) {
    node.updateWorldMatrix(true, false);
    const box = new THREE.Box3().setFromObject(node);
    const size = new THREE.Vector3();
    box.getSize(size);
    const center = new THREE.Vector3();
    box.getCenter(center);

    node.visible = false;

    const topY = box.max.y;
    const bottomY = box.min.y;

    for (let i = 0; i < FOG_LAYER_COUNT; i++) {
        const t = i / (FOG_LAYER_COUNT - 1); // 0 at top, 1 at bottom
        const y = THREE.MathUtils.lerp(topY, bottomY, t);
        const opacity = THREE.MathUtils.lerp(FOG_TOP_OPACITY, 1, Math.pow(t, FOG_FALLOFF_POWER));

        const mistGeo = new THREE.PlaneGeometry(size.x, size.z);
        const mistMat = new THREE.MeshBasicMaterial({
            color: FOG_COLOR,
            transparent: true,
            opacity,
            depthWrite: false,
        });
        const mistPlane = new THREE.Mesh(mistGeo, mistMat);
        mistPlane.rotation.x = -Math.PI / 2;
        mistPlane.position.set(center.x, y, center.z);
        // Transparent objects don't write depth, so draw order among them
        // isn't guaranteed by distance alone — force top-to-bottom order
        // explicitly so the denser lower layers always composite on top.
        mistPlane.renderOrder = i;
        scene.add(mistPlane);
    }
}
