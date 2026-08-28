import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import * as CANNON from "cannon-es";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

const hud = document.getElementById("hud");
const fadeOverlay = document.getElementById("fade-overlay");
const GLB_URL = "http://localhost:8081/assets/maze_platform_high.glb";

// ── Three.js scene ──
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xdfe6ea);

const camera = new THREE.PerspectiveCamera(
    45,
    window.innerWidth / window.innerHeight,
    0.05,
    200
);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1    ;
document.body.appendChild(renderer.domElement);

// ── Postprocessing: SELECTIVE bloom ──
// A plain single-pass UnrealBloomPass with threshold 0 blooms the entire
// frame — with this scene's light background, fog, and bright lights that
// means almost every pixel is above the threshold, so the whole window
// washes out to white. The fix is the standard three.js selective-bloom
// pattern: render the glow-path meshes on their own layer, bloom ONLY that
// layer in a separate offscreen composer, then composite the bloomed result
// back on top of the normally-lit full scene in a final pass. This keeps
// strength/radius/threshold exactly as requested while confining bloom to
// the neon path itself.
const BLOOM_LAYER = 1;
const bloomLayer = new THREE.Layers();
bloomLayer.set(BLOOM_LAYER);

const darkMaterial = new THREE.MeshBasicMaterial({ color: "black" });
const materialCache = {};

function darkenNonBloomed(obj) {
    if (obj.isMesh && bloomLayer.test(obj.layers) === false) {
        materialCache[obj.uuid] = obj.material;
        obj.material = darkMaterial;
    }
}

function restoreMaterial(obj) {
    if (materialCache[obj.uuid]) {
        obj.material = materialCache[obj.uuid];
        delete materialCache[obj.uuid];
    }
}

const renderScene = new RenderPass(scene, camera);

const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.6,  // strength
    1,    // radius
    1    // threshold
);

// Offscreen composer: renders ONLY the bloom-layer objects (everything else
// swapped to solid black first), then blooms that isolated render.
const bloomComposer = new EffectComposer(renderer);
bloomComposer.renderToScreen = false;
bloomComposer.addPass(renderScene);
bloomComposer.addPass(bloomPass);

// Final composer: renders the full scene normally, then a mix shader adds
// the bloomed texture from bloomComposer on top.
const mixPass = new ShaderPass(
    new THREE.ShaderMaterial({
        uniforms: {
            baseTexture: { value: null },
            bloomTexture: { value: bloomComposer.renderTarget2.texture },
        },
        vertexShader: `
            varying vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: `
            uniform sampler2D baseTexture;
            uniform sampler2D bloomTexture;
            varying vec2 vUv;
            void main() {
                gl_FragColor = texture2D(baseTexture, vUv) + vec4(1.0) * texture2D(bloomTexture, vUv);
            }
        `,
        defines: {},
    }),
    "baseTexture"
);
mixPass.needsSwap = true;

const outputPass = new OutputPass();

const composer = new EffectComposer(renderer);
composer.addPass(renderScene);
composer.addPass(mixPass);
composer.addPass(outputPass);

function renderWithSelectiveBloom() {
    // The scene's background color and fog aren't meshes, so
    // darkenNonBloomed() can't mask them — left alone, that light,
    // near-uniform backdrop fills almost the whole bloom-pass frame and
    // gets bloomed itself, then added on top of the final image. That's
    // what was washing the whole window white. Blank both out just for
    // the isolated bloom render, then restore them for the real one.
    const prevBackground = scene.background;
    const prevFog = scene.fog;
    scene.background = null;
    scene.fog = null;

    scene.traverse(darkenNonBloomed);
    bloomComposer.render();
    scene.traverse(restoreMaterial);

    scene.background = prevBackground;
    scene.fog = prevFog;

    composer.render();
}

const hemi = new THREE.HemisphereLight(0xffffff, 0xaabbd0, 0.8); // ★ raised back up a bit for general scene visibility now that shadows track the player correctly
scene.add(hemi);

// scene.fog = new THREE.Fog(0xdfe6ea, 8, 35);
// scene.fog = new THREE.FogExp2(0xdfe6ea, 0.035);

// scene.fog = new THREE.FogExp2(0xdfe6ea, 0.06);

// ── Ground mist plane: cheap, effective height-fog fake ──
const mistGeo = new THREE.PlaneGeometry(200, 200);
const mistMat = new THREE.MeshBasicMaterial({
    color: 0xdfe6ea,
    transparent: true,
    opacity: 0.15,
    depthWrite: false,
});
const mistPlane = new THREE.Mesh(mistGeo, mistMat);
mistPlane.rotation.x = -Math.PI / 2;
mistPlane.position.y = -1.5; // ★ set to just below your lowest visible pillar bottoms
scene.add(mistPlane);


const sun = new THREE.DirectionalLight(0xffffff, 2.4); // ★ boosted further — much brighter key light
sun.position.set(16, 80, 4); // ★ lower elevation, strongly off to one side — reads as a diagonal sun, not overhead
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 0.1;
sun.shadow.camera.far = 90;
sun.shadow.camera.left = -15;
sun.shadow.camera.right = 15;
sun.shadow.camera.top = 15;
sun.shadow.camera.bottom = -15;
sun.shadow.radius = 6.5;     // ★ tightened further for a crisper, more defined shadow edge
sun.shadow.bias = -0.0006;   // ★ slightly increased to avoid peter-panning at the new grazing angle
scene.add(sun);

// ★ The shadow camera frustum is fixed around sun.target's position (defaults
// to world origin). Without moving the target, shadows only render near
// spawn — everywhere else on the map falls outside the frustum and looks
// flat. Give the sun an explicit target and re-anchor both it and the sun
// itself to the ball every frame (see updateSunFollow below) so the shadow
// box travels with the player across the whole map.
const sunOffset = new THREE.Vector3(16, 8, 4);
scene.add(sun.target);

const fill = new THREE.DirectionalLight(0xffffff, 0.3); // ★ restored slightly alongside hemi
fill.position.set(-6, 4, -4);
scene.add(fill);

// ── Cannon-es physics world ──
const world = new CANNON.World({
    gravity: new CANNON.Vec3(0, -9.82, 0),
});
world.broadphase = new CANNON.SAPBroadphase(world);
world.allowSleep = false;
world.solver.iterations = 30;
world.solver.tolerance = 0.00005;

const floorMaterial = new CANNON.Material("floor");
const wallMaterial = new CANNON.Material("wall");
const ballMaterial = new CANNON.Material("ball");

// Wall bounce — stays the same
const wallContact = new CANNON.ContactMaterial(wallMaterial, ballMaterial, {
    friction: 0.55,
    restitution: 0.9,
    contactEquationStiffness: 1e8,
    contactEquationRelaxation: 3,
});
world.addContactMaterial(wallContact);

// Floor bounce — reduced
const floorContact = new CANNON.ContactMaterial(floorMaterial, ballMaterial, {
    friction: 0.55,
    restitution: 0.4,
    contactEquationStiffness: 1e8,
    contactEquationRelaxation: 1,
});
world.addContactMaterial(floorContact);

world.defaultContactMaterial.friction = 0.55;
world.defaultContactMaterial.restitution = 0.9;

// ── Ball ──
const BALL_RADIUS = 0.35;
const BALL_GLB_URL = "http://localhost:8081/assets/ball.glb";

function createBallTexture() {
    const size = 256;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");

    ctx.fillStyle = "#ff5533";
    ctx.fillRect(0, 0, size, size);

    ctx.fillStyle = "#a4270f";
    const stripeCount = 8;
    const stripeHeight = size / stripeCount;
    for (let i = 0; i < stripeCount; i += 2) {
        ctx.fillRect(0, i * stripeHeight, size, stripeHeight);
    }

    ctx.fillStyle = "#2b0a02";
    ctx.beginPath();
    ctx.arc(size * 0.25, size * 0.2, size * 0.05, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(size * 0.75, size * 0.8, size * 0.05, 0, Math.PI * 2);
    ctx.fill();

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    return texture;
}

// ballMesh is a Group so the loaded GLB (or the fallback sphere) can be
// swapped/added as a child while everything else keeps referencing
// ballMesh.position / ballMesh.quaternion exactly as before.
const ballMesh = new THREE.Group();
scene.add(ballMesh);

const ballLoader = new GLTFLoader();
ballLoader.load(
    BALL_GLB_URL,
    (gltf) => {
        const model = gltf.scene;

        // Normalize the imported model to BALL_RADIUS and recenter it on
        // the origin, since we don't control the source file's own scale
        // or pivot — this keeps it in sync with the physics sphere.
        const box = new THREE.Box3().setFromObject(model);
        const size = new THREE.Vector3();
        box.getSize(size);
        const center = new THREE.Vector3();
        box.getCenter(center);

        const modelRadius = Math.max(size.x, size.y, size.z) / 2;
        const scale = modelRadius > 0 ? BALL_RADIUS / modelRadius : 1;
        model.scale.setScalar(scale);
        model.position.copy(center).multiplyScalar(-scale);

        model.traverse((child) => {
            if (child.isMesh) {
                child.castShadow = true;
                child.receiveShadow = true;
            }
        });

        ballMesh.add(model);
    },
    undefined,
    (err) => {
        console.error("Failed to load ball.glb — falling back to procedural ball:", err);
        ballMesh.add(
            new THREE.Mesh(
                new THREE.SphereGeometry(BALL_RADIUS, 32, 32),
                new THREE.MeshStandardMaterial({
                    map: createBallTexture(),
                    roughness: 0.4,
                    metalness: 0.1,
                })
            )
        );
    }
);

const ballBody = new CANNON.Body({
    mass: 0.4,
    shape: new CANNON.Sphere(BALL_RADIUS),
    material: ballMaterial,
    linearDamping: 0.02,
    angularDamping: 0.02,
    ccdSpeedThreshold: 0.1,
    ccdRadius: BALL_RADIUS,
});

world.addBody(ballBody);

// ── Audio: Web Audio API sound system ──
const ASSET_BASE = "http://localhost:8081/assets/";

const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
const masterGain = audioCtx.createGain();
masterGain.gain.value = 1.0;
masterGain.connect(audioCtx.destination);

const soundBuffers = {}; // name -> decoded AudioBuffer

const SOUND_FILES = {
    bounce1: "bounce1.mp3",
    bounce2: "bounce2.mp3",
    bounce3: "bounce3.mp3",
    bounce4: "bounce4.mp3",
    bounce5: "bounce5.mp3",
    engine: "engine.mp3",
    hotspot: "hotspot.mp3",
    rolling: "rolling.mp3",
};

async function loadSound(name, file) {
    const res = await fetch(ASSET_BASE + file);
    const arrayBuffer = await res.arrayBuffer();
    soundBuffers[name] = await audioCtx.decodeAudioData(arrayBuffer);
}

const soundsReady = Promise.all(
    Object.entries(SOUND_FILES).map(([name, file]) => loadSound(name, file))
).catch((err) => console.error("Failed to load audio assets:", err));

// Browsers block audio until a user gesture — unlock on first input.
function unlockAudio() {
    if (audioCtx.state === "suspended") audioCtx.resume();
    window.removeEventListener("keydown", unlockAudio);
    window.removeEventListener("pointerdown", unlockAudio);
}
window.addEventListener("keydown", unlockAudio);
window.addEventListener("pointerdown", unlockAudio);

// ★ One-shot bounce sound: picks randomly from bounce1–bounce5
const BOUNCE_NAMES = ["bounce1", "bounce2", "bounce3", "bounce4", "bounce5"];

function playBounceSound(volume = 1) {
    const name = BOUNCE_NAMES[Math.floor(Math.random() * BOUNCE_NAMES.length)];
    const buffer = soundBuffers[name];
    if (!buffer) return; // assets may still be loading — skip rather than queue
    const source = audioCtx.createBufferSource();
    source.buffer = buffer;
    const gain = audioCtx.createGain();
    gain.gain.value = volume;
    source.connect(gain).connect(masterGain);
    source.start();
}

// Available for future use (e.g. a checkpoint / pickup trigger) — not wired
// to any event yet since none was specified.
function playHotspotSound(volume = 1) {
    const buffer = soundBuffers.hotspot;
    if (!buffer) return;
    const source = audioCtx.createBufferSource();
    source.buffer = buffer;
    const gain = audioCtx.createGain();
    gain.gain.value = volume;
    source.connect(gain).connect(masterGain);
    source.start();
}

// ★ Looping engine + rolling sources, started once at silence and then
// smoothly faded via their gain nodes each frame in updateAudio().
let engineGain = null;
let rollingGain = null;

function startLoopingSound(name) {
    const buffer = soundBuffers[name];
    if (!buffer) return null;
    const source = audioCtx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const gain = audioCtx.createGain();
    gain.gain.value = 0;
    source.connect(gain).connect(masterGain);
    source.start();
    return gain;
}

soundsReady.then(() => {
    engineGain = startLoopingSound("engine");
    rollingGain = startLoopingSound("rolling");
});

// Volume tuning
const ENGINE_MIN_GAIN = 0.05;        // faint idle noise as soon as the player inputs
const ENGINE_MAX_GAIN = 0.35;        // full volume at max speed (was 0.6 — too loud)
const ENGINE_SMOOTH = 1.8;           // slower ramp from faint → full than before
const ROLLING_MAX_GAIN = 0.5;
const ROLLING_MOVE_THRESHOLD = 0.05; // m/s below which the ball counts as stopped
const AUDIO_SMOOTH = 6;              // rolling gain transition speed — unchanged

function updateAudio(dt) {
    const speed = Math.hypot(ballBody.velocity.x, ballBody.velocity.z);
    const speedRatio = THREE.MathUtils.clamp(speed / MAX_SPEED, 0, 1);
    const isControlling = keys.forward || keys.back || keys.left || keys.right;

    // Engine: only while the player is actively steering, faint → loud with speed
    if (engineGain) {
        const targetGain = isControlling
            ? ENGINE_MIN_GAIN + (ENGINE_MAX_GAIN - ENGINE_MIN_GAIN) * speedRatio
            : 0;
        const engineEase = 1 - Math.exp(-ENGINE_SMOOTH * dt);
        engineGain.gain.value += (targetGain - engineGain.gain.value) * engineEase;
    }

    // Rolling: plays whenever the ball is actually moving, controlled or not
    if (rollingGain) {
        const targetGain = speed > ROLLING_MOVE_THRESHOLD ? ROLLING_MAX_GAIN * speedRatio : 0;
        const rollingEase = 1 - Math.exp(-AUDIO_SMOOTH * dt);
        rollingGain.gain.value += (targetGain - rollingGain.gain.value) * rollingEase;
    }
}

// ★ Bounce overlay system: smooth blending after wall impact
let wallHitPending = false;      // set on collision, processed next frame
let bounceVelocity = new CANNON.Vec3();
let bounceTimer = 0;             // time remaining for bounce overlay
const BOUNCE_DURATION = 0.3;     // seconds of smooth transition
const FLOOR_IMPACT_THRESHOLD = 0.2; // m/s of impact along the normal — below this,
                                     // it's a seam crossing between flush floor
                                     // pieces, not an actual fall/landing

ballBody.addEventListener("collide", (event) => {
    const normal = event.contact.ni;
    const now = performance.now() / 1000;

    if (Math.abs(normal.y) < 0.7) {
        // wall collision — unchanged, always plays
        wallHitPending = true;
        playBounceSound();
        return;
    }

    // floor collision — only treat this as a real "landing" if the ball
    // was airborne (per our own raycast ground check) going into this
    // physics step. isGrounded reflects the pre-step state here, since
    // checkGround() always runs before world.step() each frame. Rolling
    // across a seam between two adjacent floor meshes keeps isGrounded
    // true the whole time, so those never reach the sound below —
    // regardless of any small real impact velocity the seam produces.
    if (isGrounded) {
        return;
    }

    // Secondary sanity filter: guards against the rare case where the
    // raycast briefly misses at a beveled seam edge even though the ball
    // never really left the surface.
    const impactVelocity = Math.abs(event.contact.getImpactVelocityAlongNormal());
    if (impactVelocity < FLOOR_IMPACT_THRESHOLD) {
        return;
    }

    if (now < suppressUntil) {
        ballBody.velocity.y = 0;
        return;
    }

    if (now - lastBounceTime > BOUNCE_RESET_GAP) {
        floorBounceCount = 0;
    }
    lastBounceTime = now;
    floorBounceCount++;
    playBounceSound(0.8);

    if (floorBounceCount >= BOUNCE_LIMIT) {
        suppressUntil = now + SUPPRESS_DURATION;
        floorBounceCount = 0;
    }
});

// ── Load the level ──
const loader = new GLTFLoader();

loader.load(
    GLB_URL,
    (gltf) => {
        const root = gltf.scene;
        root.scale.multiplyScalar(1.4);
        root.updateMatrixWorld(true);
        root.rotateY(Math.PI / 2);
        scene.add(root);

        const spawnNode = root.getObjectByName("Spawn");
        const collisionRoot = root.getObjectByName("CollisionShapes");
        const glowPathRoot = root.getObjectByName("GlowPath");

        const spawnPos = new THREE.Vector3();
        if (spawnNode) {
            spawnNode.getWorldPosition(spawnPos);
            spawnNode.visible = false;
        } else {
            console.warn('No "Spawn" node found, defaulting to origin.');
        }
        spawnPos.y += 0.3;
        ballBody.position.set(spawnPos.x, spawnPos.y, spawnPos.z);
        ballBody.velocity.set(0, 0, 0);
        ballBody.angularVelocity.set(0, 0, 0);

        // ── Respawn anchor ──
        // Start the checkpoint at spawn itself, so falling before ever
        // touching ground still sends the player somewhere sane.
        lastSafePosition.copy(spawnPos);
        resetGroundedHistory(spawnPos);

        // Derive the "fell off the world" threshold from the level's own
        // geometry instead of a hardcoded number, so it still works if the
        // map changes size/scale later. Anything this far below the lowest
        // collision mesh definitely isn't on the map anymore.
        if (collisionRoot) {
            const bounds = new THREE.Box3().setFromObject(collisionRoot);
            fallThresholdY = bounds.min.y - FALL_MARGIN;
        } else {
            fallThresholdY = spawnPos.y - FALL_MARGIN;
        }
        fadeTriggerY = fallThresholdY + FADE_TRIGGER_MARGIN;

        let colliderCount = 0;
        if (collisionRoot) {
            collisionRoot.traverse((child) => {
                if (child.isMesh && child.geometry) {
                    addTrimeshCollider(child);
                    colliderCount++;
                    child.castShadow = true;
                    child.receiveShadow = true;
                    child.visible = true;

                    // Preserve original textures/maps, just upgrade the material properties
                    const oldMat = child.material;

                    child.material = new THREE.MeshPhysicalMaterial({
                        map: oldMat.map || null,                   // ★ base color texture
                        color: oldMat.map ? 0xffffff : (oldMat.color || 0x2288ee), // white so texture isn't tinted
                        normalMap: oldMat.normalMap || null,
                        normalScale: oldMat.normalScale || undefined,
                        aoMap: oldMat.aoMap || null,
                        aoMapIntensity: oldMat.aoMapIntensity ?? 1,
                        emissive: oldMat.emissive || undefined,
                        emissiveMap: oldMat.emissiveMap || null,
                        emissiveIntensity: oldMat.emissiveIntensity ?? 1,
                        roughness: 0.15,
                        metalness: 0.1,
                        clearcoat: 0.6,
                        clearcoatRoughness: 0.2,
                    });

                    // aoMap requires a second UV set — copy it over if present
                    if (oldMat.aoMap && child.geometry.attributes.uv2) {
                        child.material.aoMap = oldMat.aoMap;
                    }
                }
            });
        } else {
            console.warn('No "CollisionShapes" node found — no colliders built.');
        }

        if (glowPathRoot) {
            setupGlowPath(glowPathRoot);
        } else {
            console.warn('No "GlowPath" node found — skipping neon path glow.');
        }

        hud.textContent =
            `Loaded (5.6x world). ${colliderCount} collision meshes. WASD / Arrows to roll.`;
    },
    undefined,
    (err) => {
        console.error(err);
        hud.textContent = "Failed to load maze_platform.glb — check console.";
    }
);

// ── Acceleration curve tuning ──
// Piecewise speed-fraction curve driven by how long input has been held,
// not by a generic ease. Reaches 100% of MAX_SPEED at exactly 900ms.
function getAccelFraction(holdMs) {
    if (holdMs <= 800) {
        return THREE.MathUtils.lerp(0, 0.50, holdMs / 500);
    } else if (holdMs <= 1000) {
        const t = (holdMs - 500) / (700 - 500);
        return THREE.MathUtils.lerp(0.51, 0.70, t);
    } else if (holdMs <= 1100) {
        const t = (holdMs - 700) / (900 - 700);
        return THREE.MathUtils.lerp(0.71, 1.0, t);
    }
    return 1.0;
}



// ── Reversal skid tuning ──
const REVERSAL_SKID_DURATION = 0.35; // seconds the ball keeps sliding the old
                                      // way before the new direction fully takes over
const REVERSAL_DOT_THRESHOLD = -0.3; // how opposite the new input must be to the
                                      // ball's CURRENT VELOCITY direction to count
                                      // as a "sudden reversal" (-1 = dead opposite)
const REVERSAL_MIN_SPEED = 1.0;      // m/s — below this, don't bother skidding,
                                      // just let the normal accel curve handle it

let reversalTimer = 0;
let reversalVelocity = new CANNON.Vec3();
let prevTargetX = 0;
let prevTargetZ = 0;

// ── Respawn system ──
// lastSafePosition is where the ball respawns. Simply stamping it every
// grounded frame put it right on the edge the ball fell from — one wrong
// move and the ball just rolls straight back off. Instead we keep a short
// rolling buffer of grounded positions/timestamps and anchor respawn to
// where the ball was RESPAWN_ANCHOR_DELAY seconds before "now", not the
// literal last inch of ground it touched. Since that's a time delay (not a
// fixed distance), it scales naturally with how fast the ball was
// rolling: a fast run off a ledge lands you further back than a slow creep
// off the same edge.
const lastSafePosition = new THREE.Vector3();
const FALL_MARGIN = 5; // world units below the level's lowest collision mesh before we call it "fell off"
let fallThresholdY = -Infinity; // set once the level geometry loads; -Infinity until then so nothing triggers early

const RESPAWN_ANCHOR_DELAY = 0.4; // seconds "behind" the ball's live grounded position
const groundedHistory = []; // { t, x, y, z } samples while grounded, oldest first

// (Re)seed the history buffer with a single sample at the given position,
// used both on initial spawn and after every respawn so stale pre-fall
// samples never leak into the next fall's anchor calculation.
function resetGroundedHistory(position) {
    groundedHistory.length = 0;
    groundedHistory.push({
        t: performance.now() / 1000,
        x: position.x,
        y: position.y,
        z: position.z,
    });
}

// ── Fall transition (fade to black) ──
// A second, purely visual trigger sits FADE_TRIGGER_MARGIN meters above the
// actual respawn trigger (fallThresholdY). Crossing it starts a fade to
// black; by the time the ball actually reaches fallThresholdY and respawns,
// the screen should already be fully black, then fades back in to reveal
// the player back at their checkpoint.
const FADE_TRIGGER_MARGIN = 30; // meters above fallThresholdY
const FADE_OUT_DURATION = 0.6;  // seconds to go from clear -> black
const FADE_IN_DURATION = 0.6;   // seconds to go from black -> clear after respawn
let fadeTriggerY = -Infinity;   // set once fallThresholdY is known (see loader.load below)
let fadeState = "idle";         // "idle" | "fading-out" | "black" | "fading-in"
let fadeOpacity = 0;

function updateFade(dt) {
    switch (fadeState) {
        case "idle":
            // Crossing the upper trigger (falling past it) kicks off the fade.
            if (ballBody.position.y < fadeTriggerY) {
                fadeState = "fading-out";
            }
            break;
        case "fading-out":
            fadeOpacity = Math.min(1, fadeOpacity + dt / FADE_OUT_DURATION);
            if (fadeOpacity >= 1) {
                fadeOpacity = 1;
                fadeState = "black"; // hold at full black until respawnBall() fires
            }
            break;
        case "black":
            break;
        case "fading-in":
            fadeOpacity = Math.max(0, fadeOpacity - dt / FADE_IN_DURATION);
            if (fadeOpacity <= 0) {
                fadeOpacity = 0;
                fadeState = "idle";
            }
            break;
    }
    fadeOverlay.style.opacity = fadeOpacity;
}

function updateRespawnAnchor() {
    if (!isGrounded) return;

    const now = performance.now() / 1000;
    groundedHistory.push({
        t: now,
        x: ballBody.position.x,
        y: ballBody.position.y,
        z: ballBody.position.z,
    });

    // Trim from the front, but only while the SECOND-oldest sample is still
    // old enough to serve as the delayed anchor — that way groundedHistory[0]
    // always converges on "the freshest sample that's still >= DELAY seconds
    // old" instead of drifting all the way up to the live position.
    const target = now - RESPAWN_ANCHOR_DELAY;
    while (groundedHistory.length > 1 && groundedHistory[1].t <= target) {
        groundedHistory.shift();
    }

    const anchor = groundedHistory[0];
    lastSafePosition.set(anchor.x, anchor.y, anchor.z);
}

function checkRespawn() {
    if (ballBody.position.y < fallThresholdY) {
        respawnBall();
    }
}

function respawnBall() {
    // Small +0.3 lift, same as the initial spawn placement, so the ball
    // doesn't spawn embedded in the floor it was standing on.
    ballBody.position.set(lastSafePosition.x, lastSafePosition.y + 0.3, lastSafePosition.z);
    ballBody.velocity.set(0, 0, 0);
    ballBody.angularVelocity.set(0, 0, 0);
    floorBounceCount = 0;
    suppressUntil = 0;
    bounceTimer = 0;
    resetGroundedHistory(lastSafePosition);
    playHotspotSound(0.6); // reuse the existing (previously unwired) cue as a respawn sound

    // The fade-to-black should already be finished by the time we get here
    // (it started FADE_TRIGGER_MARGIN meters higher up) — snap to fully
    // black as a safety net in case the fall was too short/fast for that,
    // then begin fading back into the main scene at the new position.
    fadeOpacity = 1;
    fadeState = "fading-in";
}

function addTrimeshCollider(mesh) {
    mesh.updateWorldMatrix(true, false);
    const geometry = mesh.geometry.clone();
    geometry.applyMatrix4(mesh.matrixWorld);

    const posAttr = geometry.attributes.position;
    const vertices = Array.from(posAttr.array);

    let indices;
    if (geometry.index) {
        indices = Array.from(geometry.index.array);
    } else {
        indices = [];
        for (let i = 0; i < posAttr.count; i++) indices.push(i);
    }

    const shape = new CANNON.Trimesh(vertices, indices);

    // ★ pick material based on node name from your GLB hierarchy
    const isFloor = /floor/i.test(mesh.name);
    const bodyMaterial = isFloor ? floorMaterial : wallMaterial;

    const body = new CANNON.Body({ mass: 0, material: bodyMaterial });
    body.addShape(shape);
    world.addBody(body);
}

// ── Neon glow path ──
// Visual-only markers (no physics), purely decorative — swap their placeholder
// prototype texture for a bright emissive core plus two additive "halo"
// shells (tight + wide) stacked around it.
//
// The previous version built each halo by literally scaling up a copy of the
// same geometry with a flat, uniform-opacity material. That doesn't read as
// a glow — a uniformly-opaque shape just looks like a bigger, hard-edged
// duplicate of the original silhouette (a solid outline), because there's no
// falloff: every fragment on the halo has the exact same alpha whether it's
// near the core or right at the outer edge.
//
// A glow needs to fade — bright near the surface, dissolving to nothing at
// the edges. Since these halo shells can have arbitrary geometry/UVs (not
// necessarily flat discs a radial texture could map onto), the reliable way
// to get that falloff without a full bloom postprocessing pass is a Fresnel
// ("rim") shader: alpha is driven by how edge-on each fragment is relative
// to the camera, so the shell is closer to transparent where it faces the
// viewer head-on and glows brighter where it curves away — exactly the
// silhouette-hugging falloff a real bloom halo has.
const GLOW_COLOR = 0x33ccff;
const glowMaterials = []; // { mat, role, uniforms } — pulsed each frame

function createGlowShellMaterial(color, baseOpacity, power) {
    return new THREE.ShaderMaterial({
        uniforms: {
            glowColor: { value: new THREE.Color(color) },
            opacity: { value: baseOpacity },
            power: { value: power },
        },
        vertexShader: `
            varying vec3 vNormal;
            varying vec3 vViewDir;
            void main() {
                vNormal = normalize(normalMatrix * normal);
                vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
                vViewDir = normalize(-mvPosition.xyz);
                gl_Position = projectionMatrix * mvPosition;
            }
        `,
        fragmentShader: `
            uniform vec3 glowColor;
            uniform float opacity;
            uniform float power;
            varying vec3 vNormal;
            varying vec3 vViewDir;
            void main() {
                float facing = clamp(dot(normalize(vNormal), normalize(vViewDir)), 0.0, 1.0);
                // Soft falloff from bright edges to transparent center-facing
                // fragments — this is what actually fakes bloom, not the
                // scale of the shell itself.
                float rim = pow(1.0 - facing, power);
                gl_FragColor = vec4(glowColor, rim * opacity);
            }
        `,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: true,
        side: THREE.DoubleSide,
        toneMapped: false,
    });
}

function setupGlowPath(glowRoot) {
    // Collect the target meshes into a plain array FIRST. Mutating the
    // scene graph (child.add(halo)) while glowRoot.traverse() is still
    // walking it is what caused the stack overflow: traverse() reads the
    // live `children` array, so a halo added mid-walk got visited too,
    // and (since it's also a Mesh) spawned a halo of its own — recursing
    // forever. Working from a snapshot array avoids touching the tree
    // until traversal is fully done.
    const targets = [];
    glowRoot.traverse((child) => {
        if (child.isMesh) targets.push(child);
    });

    for (const child of targets) {
        // Strip the old prototype texture — the glow reads as pure emissive
        // light now, not a textured surface.
        const coreMat = new THREE.MeshStandardMaterial({
            color: GLOW_COLOR,
            emissive: GLOW_COLOR,
            emissiveIntensity: 1.6,
            roughness: 0.3,
            metalness: 0,
            toneMapped: false, // let emissive push past 1.0 and actually read as "hot"
        });
        child.material = coreMat;
        child.castShadow = false;
        child.receiveShadow = false;
        child.layers.enable(BLOOM_LAYER); // only glow-path meshes feed the bloom pass
        glowMaterials.push({ mat: coreMat, role: "core" });

        // Stack two Fresnel-rim halo shells around the core mesh — a tight
        // inner one and a wider outer one — using createGlowShellMaterial
    }
}

// Gentle breathing pulse so the path doesn't sit static — noticeable but
// not strobing. Each layer pulses over a different range so the glow feels
// like it has depth rather than just uniformly brightening/dimming.
function updateGlowPulse(elapsed) {
    const pulse = 0.5 + Math.sin(elapsed * 2.2) * 0.5; // 0 → 1
    for (const { mat, role } of glowMaterials) {
        switch (role) {
            case "core":
                mat.emissiveIntensity = 2.2 + pulse * 1.2; // ~2.2–3.4
                break;
            case "haloInner":
                mat.uniforms.opacity.value = 0.65 + pulse * 0.3; // ~0.65–0.95
                break;
            case "haloOuter":
                mat.uniforms.opacity.value = 0.3 + pulse * 0.3; // ~0.3–0.6
                break;
        }
    }
}

// ── Controls ──
const keys = { forward: false, back: false, left: false, right: false };

window.addEventListener("keydown", (e) => setKey(e.code, true));
window.addEventListener("keyup", (e) => setKey(e.code, false));

function setKey(code, value) {
    switch (code) {
        case "KeyW":
        case "ArrowUp":
            keys.forward = value;
            break;
        case "KeyS":
        case "ArrowDown":
            keys.back = value;
            break;
        case "KeyA":
        case "ArrowLeft":
            keys.left = value;
            break;
        case "KeyD":
        case "ArrowRight":
            keys.right = value;
            break;
    }
}

// ── Bounce suppression state ──
let floorBounceCount = 0;
let suppressUntil = 0;          // timestamp (ms) until which bounces are killed
let lastBounceTime = 0;
const BOUNCE_RESET_GAP = 0.6;   // seconds of no bounce = new bounce sequence
const BOUNCE_LIMIT = 3;
const SUPPRESS_DURATION = 0.5;  // seconds

ballBody.addEventListener("collide", (event) => {
    const normal = event.contact.ni;
    const now = performance.now() / 1000;

    if (Math.abs(normal.y) < 0.7) {
        // wall collision — unchanged
        wallHitPending = true;
        playBounceSound();
        return;
    }

    // floor collision
    if (now < suppressUntil) {
        // We're in the suppression window — kill the bounce outright
        ballBody.velocity.y = 0;
        return;
    }

    // Reset the counter if it's been a while since the last floor bounce
    if (now - lastBounceTime > BOUNCE_RESET_GAP) {
        floorBounceCount = 0;
    }
    lastBounceTime = now;
    floorBounceCount++;
    playBounceSound(0.8);

    if (floorBounceCount >= BOUNCE_LIMIT) {
        // This is the 3rd bounce — let it happen, then suppress afterward
        suppressUntil = now + SUPPRESS_DURATION;
        floorBounceCount = 0; // reset for the next sequence
    }
});

// ── Ground detection ──
const groundRay = new CANNON.Ray();
let groundNormal = new CANNON.Vec3(0, 1, 0);
let isGrounded = false;
const GROUND_RAY_LENGTH = BALL_RADIUS + 0.15;

function checkGround() {
    const from = ballBody.position;
    const to = new CANNON.Vec3(from.x, from.y - GROUND_RAY_LENGTH, from.z);

    const result = new CANNON.RaycastResult();
    world.raycastClosest(from, to, {
        skipBackfaces: true,
        collisionFilterMask: -1,
    }, result);

    if (result.hasHit) {
        isGrounded = true;
        groundNormal.copy(result.hitNormalWorld);
    } else {
        isGrounded = false;
        groundNormal.set(0, 1, 0);
    }
}

// ── Movement tuning ──
const MAX_SPEED = 6.3;
const ACCEL = 15;
const DECEL_RATE = 1.5;
const TURN_SMOOTHING = 4.5; // ★ lower = smoother/slower direction changes while moving.
                            // Decoupled from ACCEL so turning feels gradual
                            // independent of the speed ramp-up curve.
const currentInput = { x: 0, z: 0 };
let inputHoldTime = 0; 

// ── Slope sliding tuning ──
const SLIDE_MIN_SLOPE = 0.08;   // radians — below this, treat as "flat" and just decelerate
const SLIDE_MAX_SPEED = MAX_SPEED; // cap for how fast sliding can get (tie to MAX_SPEED, or give it its own ceiling)

function applyRollInput(dt) {
    checkGround();

    if (wallHitPending) {
        bounceVelocity.copy(ballBody.velocity);
        bounceTimer = BOUNCE_DURATION;
        wallHitPending = false;
    }

    const targetX = (keys.right ? 1 : 0) + (keys.left ? -1 : 0);
    const targetZ = (keys.forward ? -1 : 0) + (keys.back ? 1 : 0);
    const noInput = targetX === 0 && targetZ === 0;

    if (noInput) {
        currentInput.x = 0;
        currentInput.z = 0;
        inputHoldTime = 0;
        prevTargetX = 0; // ★ clear so releasing then re-pressing the same
        prevTargetZ = 0; //   direction later isn't mistaken for a reversal
        reversalTimer = 0; // ★ cancel any in-progress skid once input is let go

        const slopeAngle = Math.acos(THREE.MathUtils.clamp(groundNormal.y, -1, 1));

        if (isGrounded && slopeAngle > SLIDE_MIN_SLOPE) {
            const gravityMag = Math.abs(world.gravity.y);
            const gravityVec = new CANNON.Vec3(0, -gravityMag, 0);
            const gDot = gravityVec.dot(groundNormal);
            const downhillAccel = new CANNON.Vec3(
                gravityVec.x - groundNormal.x * gDot,
                gravityVec.y - groundNormal.y * gDot,
                gravityVec.z - groundNormal.z * gDot
            );

            ballBody.velocity.x += downhillAccel.x * dt;
            ballBody.velocity.z += downhillAccel.z * dt;

            const horizSpeed = Math.hypot(ballBody.velocity.x, ballBody.velocity.z);
            if (horizSpeed > SLIDE_MAX_SPEED) {
                const scale = SLIDE_MAX_SPEED / horizSpeed;
                ballBody.velocity.x *= scale;
                ballBody.velocity.z *= scale;
            }
            return;
        }

        const decelEase = 1 - Math.exp(-DECEL_RATE * dt);
        ballBody.velocity.x -= ballBody.velocity.x * decelEase;
        ballBody.velocity.z -= ballBody.velocity.z * decelEase;
        return;
    }

    // ★ Reversal detection — compare the new input direction against the
    // ball's ACTUAL CURRENT VELOCITY direction (not last frame's raw key
    // state). This is robust to any keyup/keydown gap frames in between,
    // since it only cares about physical momentum vs. the new command.
    if (reversalTimer <= 0) {
        const currentSpeed = Math.hypot(ballBody.velocity.x, ballBody.velocity.z);

        if (currentSpeed > REVERSAL_MIN_SPEED) {
            const velDirX = ballBody.velocity.x / currentSpeed;
            const velDirZ = ballBody.velocity.z / currentSpeed;

            const tMag = Math.hypot(targetX, targetZ);
            const inDirX = targetX / tMag;
            const inDirZ = targetZ / tMag;

            const dot = velDirX * inDirX + velDirZ * inDirZ;

            if (dot < REVERSAL_DOT_THRESHOLD) {
                reversalVelocity.set(ballBody.velocity.x, 0, ballBody.velocity.z);
                reversalTimer = REVERSAL_SKID_DURATION;
                inputHoldTime = 0; // restart the 0/500/700/900ms accel curve from zero
            }
        }
    }
    // --- Input is active ---
    inputHoldTime += dt * 1000;

    const inputEase = 1 - Math.exp(-TURN_SMOOTHING * dt);
    currentInput.x += (targetX - currentInput.x) * inputEase;
    currentInput.z += (targetZ - currentInput.z) * inputEase;

    let moveDir = new CANNON.Vec3(currentInput.x, 0, currentInput.z);
    const dot = moveDir.dot(groundNormal);
    moveDir = new CANNON.Vec3(
        moveDir.x - groundNormal.x * dot,
        moveDir.y - groundNormal.y * dot,
        moveDir.z - groundNormal.z * dot
    );

    const inputMag = Math.hypot(currentInput.x, currentInput.z);
    if (moveDir.length() > 0.0001 && inputMag > 0.0001) {
        moveDir.normalize();
        moveDir.scale(inputMag, moveDir);
    }

    const slopeAngle = Math.acos(THREE.MathUtils.clamp(groundNormal.y, -1, 1));
    const upSlopeBoost = 1 + slopeAngle * 0.6;

    const speedFraction = getAccelFraction(inputHoldTime);

    let targetVelX = moveDir.x * MAX_SPEED * upSlopeBoost * speedFraction;
    let targetVelZ = moveDir.z * MAX_SPEED * upSlopeBoost * speedFraction;
    let targetVelY = moveDir.y * MAX_SPEED * upSlopeBoost * speedFraction;

    if (bounceTimer > 0) {
        bounceTimer -= dt;
        const t = 1 - Math.max(bounceTimer / BOUNCE_DURATION, 0);
        const blend = t * t * (3 - 2 * t);
        targetVelX = bounceVelocity.x * (1 - blend) + targetVelX * blend;
        targetVelZ = bounceVelocity.z * (1 - blend) + targetVelZ * blend;
    }

    // ★ Reversal skid blend — slides from the captured old-direction
    // velocity toward the (now-restarting) new-direction target over
    // REVERSAL_SKID_DURATION. Early on this favors the old momentum, so the
    // ball keeps drifting the original way briefly; as it fades toward the
    // new target (which itself is ramping up from 0 via speedFraction), the
    // ball settles into accelerating the new direction.
    if (reversalTimer > 0) {
        reversalTimer -= dt;
        const rt = 1 - Math.max(reversalTimer / REVERSAL_SKID_DURATION, 0);
        const rBlend = rt * rt * (3 - 2 * rt);
        targetVelX = reversalVelocity.x * (1 - rBlend) + targetVelX * rBlend;
        targetVelZ = reversalVelocity.z * (1 - rBlend) + targetVelZ * rBlend;
    }

    ballBody.velocity.x = targetVelX;
    ballBody.velocity.z = targetVelZ;

    if (isGrounded && bounceTimer <= 0) {
        ballBody.velocity.y = targetVelY;
    }

    prevTargetX = targetX; // ★ remember this frame's input direction for
    prevTargetZ = targetZ; //   next frame's reversal check
}

// ── Camera follow ──
const cameraOffset = new THREE.Vector3(4.2, 6.5, 4.2);
const cameraTarget = new THREE.Vector3();

function updateCamera() {
    cameraTarget.copy(ballMesh.position);
    const desired = cameraTarget.clone().add(cameraOffset);
    camera.position.lerp(desired, 1);
    camera.lookAt(cameraTarget);
}

// ── Sun follow (keeps the shadow frustum centered on the player) ──
function updateSunFollow() {
    sun.position.copy(ballMesh.position).add(sunOffset);
    sun.target.position.copy(ballMesh.position);
    sun.target.updateMatrixWorld();
}

// ── Resize ──
window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    bloomComposer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
});

// ── Main loop ──
const clock = new THREE.Clock();

function animate() {
    requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.05);

    applyRollInput(dt);
    world.step(1 / 60, dt, 10);

    // Sync angular velocity after physics integration
    const invRadius = 1 / BALL_RADIUS;
    ballBody.angularVelocity.set(
        ballBody.velocity.z * invRadius,
        0,
        -ballBody.velocity.x * invRadius
    );

    updateRespawnAnchor();
    checkRespawn();
    updateFade(dt);

    ballMesh.position.copy(ballBody.position);
    ballMesh.quaternion.copy(ballBody.quaternion);

    updateAudio(dt);
    updateGlowPulse(clock.elapsedTime);
    updateSunFollow();
    updateCamera();
    renderWithSelectiveBloom();
}

animate();