import * as THREE from "three";

import { createLighting } from "./modules/lighting.js";
import { createPhysicsWorld } from "./modules/physicsWorld.js";
import { createBall } from "./modules/ball.js";
import { AudioManager } from "./modules/audioManager.js";
import { BloomRenderer } from "./modules/bloomRenderer.js";
import { GlowPath } from "./modules/glowPath.js";
import { PlayerFog } from "./modules/fog.js";
import { Controls } from "./modules/controls.js";
import { PlayerController } from "./modules/playerController.js";
import { CameraController } from "./modules/cameraController.js";
import { RespawnSystem } from "./modules/respawnSystem.js";
import { loadLevel } from "./modules/levelLoader.js";
import { BALL_RADIUS } from "./modules/config.js";

const hud = document.getElementById("hud");
const fadeOverlay = document.getElementById("fade-overlay");

// ── Scene / camera / renderer ──
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xdfe6ea);

const camera = new THREE.PerspectiveCamera(
    52,
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
renderer.toneMappingExposure = 1;
document.body.appendChild(renderer.domElement);

const bloomRenderer = new BloomRenderer(renderer, scene, camera);

// ── Lighting ──
const { updateSunFollow } = createLighting(scene);

// ── Physics world ──
const { world, ballMaterial, addTrimeshCollider } = createPhysicsWorld();

// ── Ball (render + physics) ──
const { ballMesh, ballBody } = createBall(scene, world, ballMaterial);

// ── Audio ──
const audioManager = new AudioManager();

// ── Neon glow path ──
const glowPath = new GlowPath();

// ── Player-relative depth fog ──
const playerFog = new PlayerFog(scene);

// ── Input / movement / camera ──
const controls = new Controls();
const player = new PlayerController(ballBody, world, controls.keys, audioManager);
const cameraController = new CameraController(camera);

// ── Respawn / fall handling ──
const respawnSystem = new RespawnSystem(ballBody, fadeOverlay, audioManager);

// ── Level ──
loadLevel({ scene, ballBody, addTrimeshCollider, glowPath, playerFog, respawnSystem, hud });

// ── Resize ──
window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    bloomRenderer.setSize(window.innerWidth, window.innerHeight);
});

// ── Main loop ──
const clock = new THREE.Clock();
const invRadius = 1 / BALL_RADIUS;

function animate() {
    requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.05);

    player.update(dt);
    world.step(1 / 60, dt, 10);

    // Sync angular velocity after physics integration
    ballBody.angularVelocity.set(
        ballBody.velocity.z * invRadius,
        0,
        -ballBody.velocity.x * invRadius
    );

    respawnSystem.updateAnchor(player.isGrounded);
    respawnSystem.checkRespawn(() => {
        player.bounceTimer = 0;
        player.ungroundedTime = 0;
    });
    respawnSystem.updateFade(dt);

    ballMesh.position.copy(ballBody.position);
    ballMesh.quaternion.copy(ballBody.quaternion);

    audioManager.update(dt, ballBody, controls.keys);
    glowPath.update(clock.elapsedTime);
    playerFog.update(ballMesh.position);
    updateSunFollow(ballMesh.position);
    cameraController.update(ballMesh, player);
    bloomRenderer.render();
}

animate();