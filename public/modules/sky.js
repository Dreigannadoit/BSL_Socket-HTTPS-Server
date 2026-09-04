import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { SKY_GLB_URL } from "./config.js";
import { fetchBinaryAsset } from "./binaryAssetLoader.js";

// Sky = a fast procedural gradient dome (always on, zero load time) with a
// photographic nebula skybox (SKY_GLB_URL — see config.js for license/
// attribution) faded in on top of it once its ~18MB texture finishes
// downloading and decoding. Keeping the gradient underneath means there's
// never a black/empty frame while the big asset streams in, and if it ever
// fails to load (slow connection, blocked asset, etc.) the gradient is a
// complete sky on its own rather than a broken fallback.
//
// Both the gradient dome and the nebula mesh live under one THREE.Group
// that's re-centered on the camera every frame, so — like the old
// single-dome version — the whole sky always reads as "infinitely far
// away" no matter how far the ball rolls across the level.
const SKY_RADIUS = 150;

// Tweak these to taste — swap in cooler/warmer hexes for a different time
// of day. Real sunrise skies aren't a two-color fade — they stack a cool
// zenith through a dusty rose/mauve band into warm gold near the horizon,
// so we use three stops instead of two.
const SKY_TOP_COLOR = 0x14213d;     // deep indigo at the zenith
const SKY_UPPER_COLOR = 0x9c6b8f;   // dusty rose/mauve band between blue and gold
const SKY_HORIZON_COLOR = 0xf3925a; // warm gold-orange near the horizon
const SKY_GLOW_COLOR = 0xffe9c7;    // soft pale glow right at the bottom of the visible dome

// The sun itself — a bright soft point of light low in the sky, not just a
// color band. sunDirection only needs x/y/z as a rough compass direction;
// it's normalized on the GPU. Nudge sunElevation toward 0 to put it right
// on the horizon, or raise it slightly for "just risen."
const SUN_DIRECTION = { x: 0.3, y: -0.05, z: -0.95 };
const SUN_COLOR = 0xfff4d6;
const SUN_SIZE = 0.015;   // smaller = tighter, more intense disc
const SUN_HALO_SIZE = 0.35; // larger = softer, wider glow around the disc

// CameraController's default offset (CAMERA_OFFSET in config.js) points the
// camera down at roughly a -45° pitch with a 45° vertical FOV — which means
// the whole visible frustum sits BELOW the true horizon (roughly -25° to
// -70° of elevation). A gradient written to blend from h=0 (horizon) up to
// h=1 (straight up) never actually shows any variation on screen, because
// every visible point clamps to the same "below the horizon" end — that
// was the original bug. Bands below are tuned to the elevation range this
// camera actually sees, so the color stack happens where the player can
// see it, and smoothstep (rather than a hard pow/clamp) keeps it a smooth
// blend instead of a flat wash.
const SKY_BAND_LOW = -1.0;    // h at/below this = pure glow color (bottom of the visible dome)
const SKY_BAND_MID_LOW = -0.6;  // h here = pure horizon color
const SKY_BAND_MID_HIGH = -0.35; // h here = pure upper/mauve color
const SKY_BAND_HIGH = -0.05;  // h at/above this = pure top color (top of the visible dome)

// ── Nebula skybox GLB ──
// The source mesh ships at whatever scale/units its author authored it in
// (this one bakes in a huge ~800-unit radius via its own node transforms) —
// far outside the camera's far-plane (200, see game.js). Rather than
// hardcoding a scale factor that'd silently break if the asset is ever
// swapped for a different one, we measure its actual bounding sphere after
// load and rescale it to fit just inside SKY_RADIUS ourselves.
const SKY_GLB_TARGET_RADIUS = SKY_RADIUS - 10; // a hair inside the gradient dome so it fully occludes it
const SKY_GLB_FADE_DURATION = 1.2; // seconds for the nebula to fade in over the gradient once loaded

// This camera never looks up — it's pinned to roughly -25° to -70° of
// elevation (see the CameraController comment above). A full-sphere space
// texture isn't evenly bright in every direction (nebula clouds/stars
// cluster unevenly, with a lot of plain black void between them), so
// whichever slice of the sphere happens to land in that fixed downward
// view cone might just be an empty patch — which reads as "the skybox is
// black" even though it loaded and is rendering correctly. Rotating the
// sphere aims a different slice of the source image into view; the
// starting guess here flips it 180° about X so whatever was the texture's
// "looking up" content (usually the busiest part of a sky/space capture)
// swings around into this camera's "looking down" cone instead. If it's
// still dark after that, nudge SKY_GLB_ROTATION_Y in ~60° steps to spin
// through the rest of the sphere until a brighter region lines up.
const SKY_GLB_ROTATION_X = Math.PI;
const SKY_GLB_ROTATION_Y = 0;

function createGradientDome() {
    const geometry = new THREE.SphereGeometry(SKY_RADIUS, 32, 16);

    const material = new THREE.ShaderMaterial({
        uniforms: {
            topColor: { value: new THREE.Color(SKY_TOP_COLOR) },
            upperColor: { value: new THREE.Color(SKY_UPPER_COLOR) },
            horizonColor: { value: new THREE.Color(SKY_HORIZON_COLOR) },
            glowColor: { value: new THREE.Color(SKY_GLOW_COLOR) },
            bandLow: { value: SKY_BAND_LOW },
            bandMidLow: { value: SKY_BAND_MID_LOW },
            bandMidHigh: { value: SKY_BAND_MID_HIGH },
            bandHigh: { value: SKY_BAND_HIGH },
            sunDirection: {
                value: new THREE.Vector3(SUN_DIRECTION.x, SUN_DIRECTION.y, SUN_DIRECTION.z).normalize(),
            },
            sunColor: { value: new THREE.Color(SUN_COLOR) },
            sunSize: { value: SUN_SIZE },
            sunHaloSize: { value: SUN_HALO_SIZE },
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
            uniform vec3 upperColor;
            uniform vec3 horizonColor;
            uniform vec3 glowColor;
            uniform float bandLow;
            uniform float bandMidLow;
            uniform float bandMidHigh;
            uniform float bandHigh;
            uniform vec3 sunDirection;
            uniform vec3 sunColor;
            uniform float sunSize;
            uniform float sunHaloSize;
            varying vec3 vWorldPosition;
            void main() {
                // vWorldPosition is relative to the dome's own (camera-
                // following) origin, so its normalized direction IS the
                // view direction — no need to subtract a separate camera
                // position here.
                vec3 viewDir = normalize(vWorldPosition);
                float h = viewDir.y;

                // Three-stop vertical gradient: glow -> horizon -> mauve -> top.
                vec3 blend1 = mix(glowColor, horizonColor, smoothstep(bandLow, bandMidLow, h));
                vec3 blend2 = mix(blend1, upperColor, smoothstep(bandMidLow, bandMidHigh, h));
                vec3 finalColor = mix(blend2, topColor, smoothstep(bandMidHigh, bandHigh, h));

                // Sun: a tight bright disc plus a much softer, wider halo
                // around it, both driven by angular distance from
                // sunDirection so it reads as an actual light source sitting
                // in the gradient rather than just another color band.
                float sunDot = dot(viewDir, sunDirection);
                float disc = smoothstep(1.0 - sunSize, 1.0 - sunSize * 0.4, sunDot);
                float halo = pow(clamp(sunDot, 0.0, 1.0), 1.0 / sunHaloSize) * 0.6;
                finalColor += sunColor * (disc + halo);

                gl_FragColor = vec4(finalColor, 1.0);
            }
        `,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
    });

    const dome = new THREE.Mesh(geometry, material);
    dome.renderOrder = 0;
    return dome;
}

// Fetches + parses the nebula GLB, rescales it to fit SKY_GLB_TARGET_RADIUS,
// swaps its material for an unlit one (the source material is emissive/
// self-lit by design — MeshBasicMaterial reproduces that without paying for
// lighting calculations three.js would otherwise run on it), and resolves
// with the ready-to-add root Object3D. Never rejects the caller into a
// broken state — errors are logged and just leave the gradient dome as the
// permanent sky.
function loadNebulaSkybox() {
    const loader = new GLTFLoader();

    // GLTFLoader.load() would fetch SKY_GLB_URL directly, which is the raw
    // (truncated-in-transit) .glb — fetch the base64 sidecar and decode it
    // ourselves instead, then hand GLTFLoader the intact bytes via .parse()
    // rather than a URL. Same pattern as levelLoader.js / ball.js.
    return fetchBinaryAsset(SKY_GLB_URL)
        .then((buffer) => new Promise((resolve, reject) => {
            loader.parse(buffer, "", resolve, reject);
        }))
        .then((gltf) => {
            const root = gltf.scene;
            root.updateMatrixWorld(true);

            const sphere = new THREE.Box3().setFromObject(root).getBoundingSphere(new THREE.Sphere());
            const scaleFactor = sphere.radius > 0 ? SKY_GLB_TARGET_RADIUS / sphere.radius : 1;
            root.scale.multiplyScalar(scaleFactor);
            root.position.sub(sphere.center.clone().multiplyScalar(scaleFactor));
            root.rotateX(SKY_GLB_ROTATION_X);
            root.rotateY(SKY_GLB_ROTATION_Y);

            let meshCount = 0;
            let texturedCount = 0;
            root.traverse((child) => {
                if (!child.isMesh) return;
                meshCount++;
                const sourceMap = child.material && (child.material.map || child.material.emissiveMap);
                if (sourceMap) texturedCount++;
                child.material = new THREE.MeshBasicMaterial({
                    map: sourceMap || null,
                    side: THREE.BackSide,
                    depthWrite: false,
                    fog: false,
                    transparent: true,
                    opacity: 0,
                });
            });
            root.renderOrder = 1; // draw after (on top of) the gradient dome

            console.log(
                `Nebula skybox loaded: ${meshCount} mesh(es), ${texturedCount} textured, ` +
                `source radius ${sphere.radius.toFixed(1)} -> scaled to ${SKY_GLB_TARGET_RADIUS}.`
            );
            if (texturedCount === 0) {
                console.warn("Nebula skybox has no texture on any mesh — it'll render as flat white, not black. Check the source material.");
            }

            return root;
        })
        .catch((err) => {
            console.error("Failed to load nebula skybox — keeping gradient sky:", err);
            return null;
        });
}

export function createSky(scene) {
    const skyGroup = new THREE.Group();
    scene.add(skyGroup);

    const dome = createGradientDome();
    skyGroup.add(dome);

    let nebulaRoot = null;
    let nebulaFadeElapsed = 0;

    loadNebulaSkybox().then((root) => {
        if (!root) return;
        skyGroup.add(root);
        nebulaRoot = root;
        nebulaFadeElapsed = 0;
    });
    let loggedFadeComplete = false;

    return {
        sky: skyGroup,
        // Call every frame with the camera's world position so the sky
        // always stays centered on the viewer, and to advance the nebula's
        // fade-in once it's loaded.
        update(cameraPosition, dt = 1 / 60) {
            skyGroup.position.copy(cameraPosition);

            if (nebulaRoot && nebulaFadeElapsed < SKY_GLB_FADE_DURATION) {
                nebulaFadeElapsed += dt;
                const opacity = Math.min(nebulaFadeElapsed / SKY_GLB_FADE_DURATION, 1);
                nebulaRoot.traverse((child) => {
                    if (child.isMesh) child.material.opacity = opacity;
                });
                if (opacity >= 1 && !loggedFadeComplete) {
                    loggedFadeComplete = true;
                    console.log("Nebula skybox fully faded in.");
                }
            }
        },
    };
}
