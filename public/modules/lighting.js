import * as THREE from "three";

// Creates and adds the scene's lights, and returns a handle for keeping the
// sun's shadow frustum centered on the player each frame.
export function createLighting(scene) {
    const hemi = new THREE.HemisphereLight(0xffffff, 0xaabbd0, 0.8); // raised for general scene visibility
    scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xffffff, 2.4); // bright key light
    sun.position.set(16, 80, 4); // lower elevation, off to one side — reads as a diagonal sun
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 0.1;
    sun.shadow.camera.far = 90;
    sun.shadow.camera.left = -15;
    sun.shadow.camera.right = 15;
    sun.shadow.camera.top = 15;
    sun.shadow.camera.bottom = -15;
    sun.shadow.radius = 6.5;   // tightened for a crisper shadow edge
    sun.shadow.bias = -0.0006; // avoids peter-panning at the grazing angle
    scene.add(sun);

    // The shadow camera frustum is fixed around sun.target's position
    // (defaults to world origin). Without moving the target, shadows only
    // render near spawn — everywhere else on the map falls outside the
    // frustum and looks flat. Give the sun an explicit target and re-anchor
    // both it and the sun itself to the ball every frame (see
    // updateSunFollow below) so the shadow box travels with the player
    // across the whole map.
    const sunOffset = new THREE.Vector3(16, 8, 4);
    scene.add(sun.target);

    const fill = new THREE.DirectionalLight(0xffffff, 0.3);
    fill.position.set(-6, 4, -4);
    scene.add(fill);

    function updateSunFollow(followTarget) {
        sun.position.copy(followTarget).add(sunOffset);
        sun.target.position.copy(followTarget);
        sun.target.updateMatrixWorld();
    }

    return { hemi, sun, fill, updateSunFollow };
}
