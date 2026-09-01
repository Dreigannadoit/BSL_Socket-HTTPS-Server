import * as THREE from "three";

// A gradient "sky dome" — a big inverted sphere centered on the camera,
// shaded blue at the zenith fading down to orange at the horizon (a
// sunrise look). We can't just set scene.background to a flat color for
// this since that gives one solid color; a screen-space canvas gradient
// texture would also work but wouldn't react correctly if the camera ever
// rolls (see CameraController's skid-roll tilt) — a real 3D dome handles
// that naturally since it's just another mesh in the world.
//
// The dome is rendered with its normals flipped inward (BackSide) so we
// see the inside of the sphere from wherever the camera sits, and it's
// re-centered on the camera every frame so it always reads as "infinitely
// far away" no matter how far the ball rolls across the level.
const SKY_RADIUS = 150;

// Tweak these to taste — swap in cooler/warmer hexes for a different time
// of day.
const SKY_TOP_COLOR = 0x0b1d3a;     // dark, saturated sky blue at the zenith
const SKY_HORIZON_COLOR = 0x8ecdf5; // light sky blue, most of the lower dome
const SKY_GLOW_COLOR = 0xd6f1ff;    // near-white pale blue right at the horizon line, for a soft bottom highlight

// CameraController's default offset (CAMERA_OFFSET in config.js) points the
// camera down at roughly a -45° pitch with a 45° vertical FOV — which means
// the whole visible frustum sits BELOW the true horizon (roughly -25° to
// -70° of elevation). A gradient written to blend from h=0 (horizon) up to
// h=1 (straight up) never actually shows any variation on screen, because
// every visible point clamps to the same "below the horizon" end — that
// was the original bug. Bands below are tuned to the elevation range this
// camera actually sees, so the blue-to-orange transition happens where the
// player can see it, and a smoothstep (rather than a hard pow/clamp) keeps
// it a smooth blend instead of a flat wash.
const SKY_BAND_LOW = -1.0;   // h at/below this = pure glow color (bottom of the visible dome)
const SKY_BAND_MID = -0.55;  // h here = pure horizon color
const SKY_BAND_HIGH = -0.05; // h at/above this = pure top color (top of the visible dome)

export function createSky(scene) {
    const geometry = new THREE.SphereGeometry(SKY_RADIUS, 32, 16);

    const material = new THREE.ShaderMaterial({
        uniforms: {
            topColor: { value: new THREE.Color(SKY_TOP_COLOR) },
            horizonColor: { value: new THREE.Color(SKY_HORIZON_COLOR) },
            glowColor: { value: new THREE.Color(SKY_GLOW_COLOR) },
            bandLow: { value: SKY_BAND_LOW },
            bandMid: { value: SKY_BAND_MID },
            bandHigh: { value: SKY_BAND_HIGH },
        },
        vertexShader: `
            varying vec3 vWorldPosition;
            void main() {
                vec4 worldPosition = modelMatrix * vec4(position, 1.0);
                vWorldPosition = worldPosition.xyz;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: `
            uniform vec3 topColor;
            uniform vec3 horizonColor;
            uniform vec3 glowColor;
            uniform float bandLow;
            uniform float bandMid;
            uniform float bandHigh;
            varying vec3 vWorldPosition;
            void main() {
                // vWorldPosition is relative to the dome's own (camera-
                // following) origin, so its normalized height IS the
                // view-direction elevation — no need to subtract a
                // separate camera position here.
                float h = normalize(vWorldPosition).y;

                vec3 lowerBlend = mix(glowColor, horizonColor, smoothstep(bandLow, bandMid, h));
                vec3 finalColor = mix(lowerBlend, topColor, smoothstep(bandMid, bandHigh, h));

                gl_FragColor = vec4(finalColor, 1.0);
            }
        `,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
    });

    const sky = new THREE.Mesh(geometry, material);
    // Sky shouldn't participate in raycasts, shadows, or the bloom /
    // color-mask passes' scene traversal side effects.
    sky.matrixAutoUpdate = true;
    scene.add(sky);

    return {
        sky,
        // Call every frame with the camera's world position so the dome
        // always stays centered on the viewer.
        update(cameraPosition) {
            sky.position.copy(cameraPosition);
        },
    };
}