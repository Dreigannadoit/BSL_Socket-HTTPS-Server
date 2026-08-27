import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import * as CANNON from "cannon-es";

const hud = document.getElementById("hud");
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
document.body.appendChild(renderer.domElement);

const hemi = new THREE.HemisphereLight(0xffffff, 0xaabbd0, 0.8); // ★ raised back up a bit for general scene visibility now that shadows track the player correctly
scene.add(hemi);

// scene.fog = new THREE.Fog(0xdfe6ea, 8, 35);
// scene.fog = new THREE.FogExp2(0xdfe6ea, 0.035);

scene.fog = new THREE.FogExp2(0xdfe6ea, 0.06);

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

ballBody.addEventListener("collide", (event) => {
    // Only respond to wall-like collisions (horizontal normal)
    const normal = event.contact.ni;
    if (Math.abs(normal.y) < 0.7) {
        wallHitPending = true;
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

// ── Respawn system ──
// lastSafePosition is stamped every frame the ball is grounded (see
// applyRollInput → checkGround, which already runs every frame). Because
// isGrounded flips false the instant the ball leaves a platform, whatever
// got saved right before that is effectively the edge the ball fell from —
// exactly the "respawn where I fell off" behavior asked for, with no extra
// edge-detection logic needed.
const lastSafePosition = new THREE.Vector3();
const FALL_MARGIN = 5; // world units below the level's lowest collision mesh before we call it "fell off"
let fallThresholdY = -Infinity; // set once the level geometry loads; -Infinity until then so nothing triggers early

function updateRespawnAnchor() {
    if (isGrounded) {
        lastSafePosition.copy(ballBody.position);
    }
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
    playHotspotSound(0.6); // reuse the existing (previously unwired) cue as a respawn sound
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
// duplicates (tight + wide) stacked around it. Layering two halos at
// different sizes/opacities fakes a bloom falloff — bright near the surface,
// soft and wide further out — without the cost of a full postprocessing pass.
const GLOW_COLOR = 0x33ccff;
const glowMaterials = []; // { mat, role } — pulsed each frame

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
            emissiveIntensity: 2.6,
            roughness: 0.3,
            metalness: 0,
            toneMapped: false, // let emissive push past 1.0 and actually read as "hot"
        });
        child.material = coreMat;
        child.castShadow = false;
        child.receiveShadow = false;
        glowMaterials.push({ mat: coreMat, role: "core" });

        // Tight, bright halo — hugs the geometry closely
        const innerMat = new THREE.MeshBasicMaterial({
            color: GLOW_COLOR,
            transparent: true,
            opacity: 0.55,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            side: THREE.DoubleSide,
            toneMapped: false,
        });
        const innerHalo = new THREE.Mesh(child.geometry, innerMat);
        innerHalo.scale.setScalar(1.18);
        innerHalo.renderOrder = 1;
        child.add(innerHalo);
        glowMaterials.push({ mat: innerMat, role: "haloInner" });

        // Wide, soft halo — the part that reads as ambient light bleeding
        // off the path rather than the object itself
        const outerMat = new THREE.MeshBasicMaterial({
            color: GLOW_COLOR,
            transparent: true,
            opacity: 0.22,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            side: THREE.DoubleSide,
            toneMapped: false,
        });
        const outerHalo = new THREE.Mesh(child.geometry, outerMat);
        outerHalo.scale.setScalar(1.55);
        outerHalo.renderOrder = 1;
        child.add(outerHalo);
        glowMaterials.push({ mat: outerMat, role: "haloOuter" });
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
                mat.opacity = 0.4 + pulse * 0.3; // ~0.4–0.7
                break;
            case "haloOuter":
                mat.opacity = 0.14 + pulse * 0.22; // ~0.14–0.36
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
const MAX_SPEED = 4.6;
const ACCEL = 15;
const DECEL_RATE = 1.5;
const currentInput = { x: 0, z: 0 };

// ── Slope sliding tuning ──
const SLIDE_MIN_SLOPE = 0.08;   // radians — below this, treat as "flat" and just decelerate
const SLIDE_MAX_SPEED = MAX_SPEED; // cap for how fast sliding can get (tie to MAX_SPEED, or give it its own ceiling)

function applyRollInput(dt) {
    checkGround();

    // Process wall-hit bounce (unchanged)
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

        const slopeAngle = Math.acos(THREE.MathUtils.clamp(groundNormal.y, -1, 1));

        if (isGrounded && slopeAngle > SLIDE_MIN_SLOPE) {
            // ★ Real acceleration, not ease-to-target. Project gravity's
            // magnitude onto the slope plane to get a downhill accel
            // vector, then integrate it into velocity every frame like
            // actual gravity would (v += a*dt). This keeps building speed
            // over time instead of snapping to a plateau.
            const gravityMag = Math.abs(world.gravity.y); // 9.82
            const gravityVec = new CANNON.Vec3(0, -gravityMag, 0);
            const gDot = gravityVec.dot(groundNormal);
            const downhillAccel = new CANNON.Vec3(
                gravityVec.x - groundNormal.x * gDot,
                gravityVec.y - groundNormal.y * gDot,
                gravityVec.z - groundNormal.z * gDot
            );

            // Only the horizontal component drives horizontal sliding —
            // vertical is already handled by gravity/physics itself.
            ballBody.velocity.x += downhillAccel.x * dt;
            ballBody.velocity.z += downhillAccel.z * dt;

            // Cap the horizontal slide speed so it doesn't run away forever
            const horizSpeed = Math.hypot(ballBody.velocity.x, ballBody.velocity.z);
            if (horizSpeed > SLIDE_MAX_SPEED) {
                const scale = SLIDE_MAX_SPEED / horizSpeed;
                ballBody.velocity.x *= scale;
                ballBody.velocity.z *= scale;
            }
            return;
        }

        // Flat ground (or airborne): ease horizontal velocity toward zero.
        const decelEase = 1 - Math.exp(-DECEL_RATE * dt);
        ballBody.velocity.x -= ballBody.velocity.x * decelEase;
        ballBody.velocity.z -= ballBody.velocity.z * decelEase;
        return;
    }

    // --- Input is active: smoothly adjust currentInput ---
    const inputEase = 1 - Math.exp(-ACCEL * dt);
    currentInput.x += (targetX - currentInput.x) * inputEase;
    currentInput.z += (targetZ - currentInput.z) * inputEase;

    // Project input direction onto the slope plane
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

    // Slope boost (helps going uphill)
    const slopeAngle = Math.acos(THREE.MathUtils.clamp(groundNormal.y, -1, 1));
    const upSlopeBoost = 1 + slopeAngle * 0.6;

    let targetVelX = moveDir.x * MAX_SPEED * upSlopeBoost;
    let targetVelZ = moveDir.z * MAX_SPEED * upSlopeBoost;
    let targetVelY = moveDir.y * MAX_SPEED * upSlopeBoost;

    // Blend bounce overlay (unchanged)
    if (bounceTimer > 0) {
        bounceTimer -= dt;
        const t = 1 - Math.max(bounceTimer / BOUNCE_DURATION, 0);
        const blend = t * t * (3 - 2 * t);
        targetVelX = bounceVelocity.x * (1 - blend) + targetVelX * blend;
        targetVelZ = bounceVelocity.z * (1 - blend) + targetVelZ * blend;
    }

    const velEase = 1 - Math.exp(-ACCEL * dt);
    ballBody.velocity.x += (targetVelX - ballBody.velocity.x) * velEase;
    ballBody.velocity.z += (targetVelZ - ballBody.velocity.z) * velEase;

    // Only control vertical velocity while grounded on a slope and not in air
    if (isGrounded && bounceTimer <= 0) {
        ballBody.velocity.y += (targetVelY - ballBody.velocity.y) * velEase;
    }

    // Remove the angular velocity sync here – we'll do it after physics step
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

    ballMesh.position.copy(ballBody.position);
    ballMesh.quaternion.copy(ballBody.quaternion);

    updateAudio(dt);
    updateGlowPulse(clock.elapsedTime);
    updateSunFollow();
    updateCamera();
    renderer.render(scene, camera);
}

animate();