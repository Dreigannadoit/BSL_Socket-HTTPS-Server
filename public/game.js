import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import * as CANNON from "cannon-es";

const hud = document.getElementById("hud");

// The .glb is served by the same asset server this script came from (:8081).
// Using an absolute URL here (not a relative one) matters: GLTFLoader resolves
// relative paths against the HTML document's location (localhost:8080), not
// against this script's own origin — so a relative path would silently point
// at the wrong port.
const GLB_URL = "http://localhost:8081/maze_platform.glb";

// ---------- Three.js scene ----------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x222233);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.05, 200);

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

// ---------- Cannon-es physics world ----------
const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
world.broadphase = new CANNON.SAPBroadphase(world);
world.allowSleep = false;
world.solver.iterations = 20;
world.solver.tolerance = 0.0001;

const groundMaterial = new CANNON.Material("ground");
const ballMaterial = new CANNON.Material("ball");
const contact = new CANNON.ContactMaterial(groundMaterial, ballMaterial, {
    // Friction here now works against us: the ball is fixedRotation (never
    // spins), so from the solver's point of view it's always "sliding" at the
    // contact point. Real friction would fight the velocity we set directly in
    // applyRollInput every single step. We control speed ourselves, so we want
    // this close to frictionless for movement — it only needs to be nonzero
    // enough that the ball doesn't feel like it's on a perfectly frictionless
    // sheet against walls.
    friction: 0.02,
    restitution: 0.05,
    contactEquationStiffness: 1e8,
    contactEquationRelaxation: 3,
});
world.addContactMaterial(contact);
world.defaultContactMaterial.friction = 0.02;
world.defaultContactMaterial.restitution = 0.05;

// ---------- Ball ----------
const BALL_RADIUS = 0.35;

// A flat single-color sphere gives no visual cue that it's rotating at all —
// it looks identical whether it's spinning or perfectly still. This draws a
// striped pattern onto a canvas and uses it as the ball's texture, so the
// roll is actually visible instead of just being correct "in theory."
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

    // A couple of dark dots as extra asymmetric landmarks — makes spin around
    // any axis readable, not just the axis the stripes happen to wrap around.
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
    new THREE.MeshStandardMaterial({ map: createBallTexture(), roughness: 0.4, metalness: 0.1 })
);
ballMesh.castShadow = true;
scene.add(ballMesh);

const ballBody = new CANNON.Body({
    mass: 0.4,
    shape: new CANNON.Sphere(BALL_RADIUS),
    material: ballMaterial,
    // Kept low and mostly as a safety net now — the STOP_ACCEL brake below
    // (derived from COAST_DISTANCE) is what deliberately controls how far the
    // ball slides after you release input. If this were still high, it would
    // fight that and make the coast distance unpredictable.
    linearDamping: 0.05,
    ccdSpeedThreshold: 0.1,
    ccdRadius: BALL_RADIUS,
});
// We drive movement by setting velocity directly (see applyRollInput below),
// not by applying torque and hoping friction converts spin into motion.
// That torque->friction approach is what caused the "rolling on ice" feel:
// it depends on the ball's contact with a Trimesh collider having reliable
// friction, and cannon-es's friction on concave trimesh geometry is known to
// be inconsistent — the ball can spin without actually gripping.
// fixedRotation stops physics (torque, collisions) from spinning the body at
// all; the visible "rolling" is instead faked cosmetically further down,
// based on how far the ball has actually moved, so it always looks right
// regardless of contact/friction quality.
ballBody.fixedRotation = true;
ballBody.updateMassProperties();
world.addBody(ballBody);

// ---------- Load the level ----------
const loader = new GLTFLoader();

loader.load(
    GLB_URL,
    (gltf) => {
        const root = gltf.scene;

        // ---- SCALE THE WORLD 5.6x ----
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

        hud.textContent = `Loaded (5.6x world). ${colliderCount} collision meshes. WASD / Arrows to roll.`;
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
        for (let i = 0; i < posAttr.count; i++) {
            indices.push(i);
        }
    }

    const shape = new CANNON.Trimesh(vertices, indices);

    const body = new CANNON.Body({ mass: 0, material: groundMaterial });
    body.addShape(shape);

    // World transform is already baked into the vertices above, so the body
    // itself stays at the origin/identity.
    world.addBody(body);
}

// ---------- Controls: direct velocity control ----------
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

const MAX_SPEED = 4.5;   // top horizontal speed in units/sec — leaving this as-is, speed felt right
const ACCEL = 6;         // was 14 — lower = softer ramp-up, less "instantly at full speed" stiffness

// Instead of picking an abstract brake rate directly, we pick the actual
// distance (in world units) we want the ball to slide after you let go at
// TOP speed, and derive the brake rate from that. For exponential decay
// v(t) = v0 * e^(-k*t), total distance traveled works out to v0/k — so
// k = MAX_SPEED / COAST_DISTANCE caps the slide to roughly COAST_DISTANCE
// even at max speed, and proportionally less at lower speeds.
const COAST_DISTANCE = 3.5; // world units the ball slides after release, at top speed — raise/lower to taste
const STOP_ACCEL = MAX_SPEED / COAST_DISTANCE;

const currentInput = { x: 0, z: 0 }; // eased input direction, same as before

function applyRollInput(dt) {
    const targetX = (keys.right ? -1 : 0) + (keys.left ? 1 : 0);
    const targetZ = (keys.forward ? 1 : 0) + (keys.back ? -1 : 0);

    const noInput = targetX === 0 && targetZ === 0;

    // 1. Instantly drop input targets when keys are released so we stop trying to drive full speed
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

    // 2. Smoothly decay velocity when no input is provided instead of snapping
    const velEase = 1 - Math.exp(-(noInput ? STOP_ACCEL : ACCEL) * dt);

    ballBody.velocity.x += (targetVelX - ballBody.velocity.x) * velEase;
    ballBody.velocity.z += (targetVelZ - ballBody.velocity.z) * velEase;
}
// ---------- Purely cosmetic rolling ----------
// Physics rotation is frozen (fixedRotation), so we spin the mesh manually.
// Rather than reading the ball's actual velocity directly (which would stop
// spinning the instant the ball stops moving), we track a separate "visual
// roll velocity" that has its own momentum: it catches up quickly while the
// ball is actively moving, but decays slowly once real movement stops — so
// it keeps rolling for a beat afterward, like real momentum, without
// affecting the ball's actual physics/position at all.
const rollAxis = new THREE.Vector3();
const rollDelta = new THREE.Quaternion();
const rollVel = { x: 0, z: 0 };

const ROLL_CATCH_UP = 12;  // how fast the visual spin matches real movement when speeding up
const ROLL_COAST_DOWN = 2.5; // how slowly it spins down after the ball actually stops — lower = longer coast-roll

function applyVisualRoll(dt) {
    const vx = ballBody.velocity.x;
    const vz = ballBody.velocity.z;
    const actualSpeed = Math.sqrt(vx * vx + vz * vz);
    const rollSpeed = Math.sqrt(rollVel.x * rollVel.x + rollVel.z * rollVel.z);

    // Chase actual velocity quickly when it's higher (speeding up / turning),
    // but fall back to it slowly when it's lower (the ball has slowed/stopped)
    // — that asymmetry is what creates the coast-out effect.
    const rate = actualSpeed >= rollSpeed ? ROLL_CATCH_UP : ROLL_COAST_DOWN;
    const t = 1 - Math.exp(-rate * dt);
    rollVel.x += (vx - rollVel.x) * t;
    rollVel.z += (vz - rollVel.z) * t;

    const speed = Math.sqrt(rollVel.x * rollVel.x + rollVel.z * rollVel.z);
    if (speed < 0.001) return;

    // Axis perpendicular to both "up" and the movement direction
    rollAxis.set(rollVel.z, 0, -rollVel.x).normalize();
    const angle = (speed * dt) / BALL_RADIUS;

    rollDelta.setFromAxisAngle(rollAxis, angle);
    ballMesh.quaternion.premultiply(rollDelta);
}

// ---------- Camera follow ----------
const cameraOffset = new THREE.Vector3(4.2, 6.5, 4.2);
const cameraTarget = new THREE.Vector3();

function updateCamera() {
    cameraTarget.copy(ballMesh.position);
    const desired = cameraTarget.clone().add(cameraOffset);
    camera.position.lerp(desired, 1);
    camera.lookAt(cameraTarget);
}

// ---------- Resize ----------
window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- Main loop ----------
const clock = new THREE.Clock();

function animate() {
    requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.05);

    applyRollInput(dt);
    world.step(1 / 60, dt, 10);

    ballMesh.position.copy(ballBody.position);
    applyVisualRoll(dt);

    updateCamera();
    renderer.render(scene, camera);
}

animate();
