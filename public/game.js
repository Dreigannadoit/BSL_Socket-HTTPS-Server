import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import * as CANNON from "cannon-es";

const hud = document.getElementById("hud");
const GLB_URL = "http://localhost:8081/maze_platform.glb";

// ── Three.js scene ──
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xdfe6ea);

const camera = new THREE.PerspectiveCamera(
    40,
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

const hemi = new THREE.HemisphereLight(0xffffff, 0xaabbd0, 1.4); // strong, neutral-cool fill
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


const sun = new THREE.DirectionalLight(0xffffff, 1.0); // no warm tint — keep it neutral/cool
sun.position.set(4, 20, 4);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 0.1;
sun.shadow.camera.far = 50;
sun.shadow.camera.left = -15;
sun.shadow.camera.right = 15;
sun.shadow.camera.top = 15;
sun.shadow.camera.bottom = -15;
sun.shadow.radius = 6;       // very soft-edged shadows — barely-there contact shadows
sun.shadow.bias = -0.0004;
scene.add(sun);

const fill = new THREE.DirectionalLight(0xffffff, 0.4);
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
world.defaultContactMaterial.restitution = 0.2;

// ── Ball ──
const BALL_RADIUS = 0.35;

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

const ballMesh = new THREE.Mesh(
    new THREE.SphereGeometry(BALL_RADIUS, 32, 32),
    new THREE.MeshStandardMaterial({
        map: createBallTexture(),
        roughness: 0.4,
        metalness: 0.1,
    })
);
ballMesh.castShadow = true;
scene.add(ballMesh);

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
        root.scale.multiplyScalar(5.6);
        root.updateMatrixWorld(true);
        scene.add(root);

        const spawnNode = root.getObjectByName("Spawn");
        const collisionRoot = root.getObjectByName("CollisionShapes");

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

        hud.textContent =
            `Loaded (5.6x world). ${colliderCount} collision meshes. WASD / Arrows to roll.`;
    },
    undefined,
    (err) => {
        console.error(err);
        hud.textContent = "Failed to load maze_platform.glb — check console.";
    }
);

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
const MAX_SPEED = 4.3;
const ACCEL = 9;
const DECEL_RATE = 1.2;
const currentInput = { x: 0, z: 0 };

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
        // ★ No input → do NOT force velocity to zero.
        // Let physics (gravity + friction) move the ball naturally.
        // Only reset the smoothed input values for next time.
        currentInput.x = 0;
        currentInput.z = 0;
        return;   // ← skip all velocity manipulation
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

    ballMesh.position.copy(ballBody.position);
    ballMesh.quaternion.copy(ballBody.quaternion);

    updateCamera();
    renderer.render(scene, camera);
}

animate();