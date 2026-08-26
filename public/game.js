import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import * as CANNON from "cannon-es";

const hud = document.getElementById("hud");

const GLB_URL = "http://localhost:8081/maze_platform.glb";

// ── Three.js scene ──
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x222233);

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

const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1.2);
scene.add(hemi);

const sun = new THREE.DirectionalLight(0xffffff, 1.5);
sun.position.set(5, 10, 5);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 0.1;
sun.shadow.camera.far = 50;
sun.shadow.camera.left = -15;
sun.shadow.camera.right = 15;
sun.shadow.camera.top = 15;
sun.shadow.camera.bottom = -15;
scene.add(sun);

// ── Cannon-es physics world ──
const world = new CANNON.World({
    gravity: new CANNON.Vec3(0, -9.82, 0),
});
world.broadphase = new CANNON.SAPBroadphase(world);
world.allowSleep = false;
world.solver.iterations = 30;
world.solver.tolerance = 0.00005;

const groundMaterial = new CANNON.Material("ground");
const ballMaterial = new CANNON.Material("ball");

// Friction is set high enough for realistic rolling and wall interactions
const contact = new CANNON.ContactMaterial(groundMaterial, ballMaterial, {
    friction: 0.55,
    restitution: 0.08,
    contactEquationStiffness: 1e8,
    contactEquationRelaxation: 3,
});
world.addContactMaterial(contact);
world.defaultContactMaterial.friction = 0.55;
world.defaultContactMaterial.restitution = 0.08;

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
    // Damping values give a natural, gradual stop when no input is given.
    // They also work with the angular damping to maintain rolling coherence.
    linearDamping: 0.02,
    angularDamping: 0.02,
    ccdSpeedThreshold: 0.1,
    ccdRadius: BALL_RADIUS,
});

world.addBody(ballBody);

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
    const body = new CANNON.Body({ mass: 0, material: groundMaterial });
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

// ── Movement tuning ──
const MAX_SPEED = 4.5;   // top horizontal speed in units/sec
const ACCEL = 8;         // how fast the ball reaches target velocity while keys are held
const DECEL_RATE = 1.2;  // ★ NEW: gentler deceleration when no keys are pressed — makes the coast-out last longer

const currentInput = { x: 0, z: 0 };

/**
 * Reworked movement system: direct velocity control with real rolling.
 * - Input is smoothed, no instant jumps.
 * - When keys are released, we ease velocity to zero using DECEL_RATE
 *   (much lower than ACCEL), giving a gradual, natural stop.
 * - Angular velocity is always matched to linear velocity so the ball
 *   visibly rolls.
 */
function applyRollInput(dt) {
    const targetX = (keys.right ? 1 : 0) + (keys.left ? -1 : 0);
    const targetZ = (keys.forward ? -1 : 0) + (keys.back ? 1 : 0);
    const noInput = targetX === 0 && targetZ === 0;

    if (noInput) {
        currentInput.x = 0;
        currentInput.z = 0;
    } else {
        const inputEase = 1 - Math.exp(-ACCEL * dt);
        currentInput.x += (targetX - currentInput.x) * inputEase;
        currentInput.z += (targetZ - currentInput.z) * inputEase;
    }

    const targetVelX = currentInput.x * MAX_SPEED;
    const targetVelZ = currentInput.z * MAX_SPEED;

    // Use a much lower easing rate when coasting to a stop
    const velEase = 1 - Math.exp(-(noInput ? DECEL_RATE : ACCEL) * dt);

    ballBody.velocity.x += (targetVelX - ballBody.velocity.x) * velEase;
    ballBody.velocity.z += (targetVelZ - ballBody.velocity.z) * velEase;

    // Synchronize angular velocity for rolling without slipping
    const invRadius = 1 / BALL_RADIUS;
    ballBody.angularVelocity.set(
        ballBody.velocity.z * invRadius,
        0,
        -ballBody.velocity.x * invRadius
    );
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

    ballMesh.position.copy(ballBody.position);
    ballMesh.quaternion.copy(ballBody.quaternion);

    updateCamera();
    renderer.render(scene, camera);
}

animate();