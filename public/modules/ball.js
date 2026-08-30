import * as THREE from "three";
import * as CANNON from "cannon-es";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { BALL_RADIUS, BALL_GLB_URL } from "./config.js";
import { BallGlow } from "./ballGlow.js";

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

// Creates the ball's render representation and physics body. ballMesh is a
// Group so the loaded GLB (or the fallback sphere) can be swapped/added as
// a child while everything else keeps referencing ballMesh.position /
// ballMesh.quaternion the same way regardless of which one loaded.
export function createBall(scene, world, ballMaterial) {
    const ballMesh = new THREE.Group();
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

    const ballGlow = new BallGlow();

    const ballLoader = new GLTFLoader();
    ballLoader.load(
        BALL_GLB_URL,
        (gltf) => {
            const model = gltf.scene;

            // Normalize the imported model to BALL_RADIUS and recenter it
            // on the origin, since we don't control the source file's own
            // scale or pivot — this keeps it in sync with the physics
            // sphere.
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

            // Looks for primitives using the "inner_ball" / "ball_light"
            // materials and wires them up for speed-linked bloom — see
            // ballGlow.js.
            ballGlow.setup(model);

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

    return { ballMesh, ballBody, ballGlow };
}