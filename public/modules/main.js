import * as THREE from "three";

import { createSky } from "./sky.js";
import { createLighting } from "./lighting.js";
import { createPhysicsWorld } from "./physicsWorld.js";
import { createBall } from "./ball.js";
import { AudioManager } from "./audioManager.js";
import { BloomRenderer } from "./bloomRenderer.js";
import { GlowPath } from "./glowPath.js";
import { PlayerFog } from "./fog.js";
import { Controls } from "./controls.js";
import { PlayerController } from "./playerController.js";
import { CameraController } from "./cameraController.js";
import { RespawnSystem } from "./respawnSystem.js";
import { HotspotSystem } from "./hotspotSystem.js";
import { DevTools } from "./devTools.js";
import { GameModeManager } from "./gameModeManager.js";
import { GameModeUI } from "./gameModeUI.js";
import { MovableObjectSystem } from "./movableObjectSystem.js";
import { MovableObjectBillboard } from "./movableObjectBillboard.js";
import { loadLevel } from "./levelLoader.js";
import { BALL_RADIUS, HOTSPOT_STUCK_DURATION, GLB_URL } from "./config.js";

// Boots the whole game — scene, physics, ball, camera, hotspots, game
// modes, dev tools, and the level itself. Used by both the main game
// (game.js, default maze GLB) and the about page (about.js), which is
// identical in every way except which world it loads — see `levelUrl`.
export function startGame({ levelUrl = GLB_URL } = {}) {
    const hud = document.getElementById("hud");
    const fadeOverlay = document.getElementById("fade-overlay");
    const hotspotPopup = document.getElementById("hotspot-popup");

    // ── Scene / camera / renderer ──
    const scene = new THREE.Scene();

    // ── Sky ──
    // A camera-following gradient dome (sunrise: indigo overhead through a
    // dusty rose band to a glowing horizon sun) that shows instantly, with the
    // nebula skybox GLB fading in on top of it once its texture finishes
    // loading — see sky.js.
    const { update: updateSky } = createSky(scene);

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
    renderer.toneMappingExposure = 1;
    document.body.appendChild(renderer.domElement);

    const bloomRenderer = new BloomRenderer(renderer, scene, camera);

    // ── Lighting ──
    const { updateSunFollow } = createLighting(scene);

    // ── Physics world ──
    const { world, floorMaterial, wallMaterial, ballMaterial, addTrimeshCollider } = createPhysicsWorld();

    // ── Ball (render + physics) ──
    const { ballMesh, ballBody, ballGlow } = createBall(scene, world, ballMaterial);

    // ── Audio ──
    const audioManager = new AudioManager();

    // ── Neon glow path ──
    const glowPath = new GlowPath();

    // ── Brand glow (same core-emissive + bloom treatment as GlowPath, applied
    // to the "Brand" group's "Branding" meshes instead of the neon path) ──
    const brandGlow = new GlowPath();

    // ── Player-relative depth fog ──
    const playerFog = new PlayerFog(scene);

    // ── Input / movement / camera ──
    const controls = new Controls();
    const player = new PlayerController(ballBody, world, controls.keys, audioManager);
    const cameraController = new CameraController(camera);

    // ── Respawn / fall handling ──
    const respawnSystem = new RespawnSystem(ballBody, fadeOverlay, audioManager);

    // ── Game-mode UI (mode badge, timer/orb readout, result popups) ──
    const gameModeUI = new GameModeUI();

    // ── Hotspot triggers ──
    // Hotspot_1 doubles as the mode-select menu (see hotspotSystem.js's
    // HOTSPOT_CONTENT) — context wires its buttons into gameModeManager below.
    // gameModeManager is declared after this, but these callbacks only ever
    // fire later (once the player actually clicks a button), by which point
    // it's fully constructed.
    const hotspotSystem = new HotspotSystem(hotspotPopup, () => player.stick(HOTSPOT_STUCK_DURATION), {
        onSelectMode: (mode) => gameModeManager.selectMode(mode),
        getCurrentMode: () => gameModeManager.getMode(),
    });

    // ── Game modes (Free Roam / Speedrun / Time Trial) ──
    const gameModeManager = new GameModeManager({
        scene,
        world,
        addTrimeshCollider,
        ballBody,
        player,
        respawnSystem,
        hotspotSystem,
        audioManager,
        ui: gameModeUI,
        glowPath,
    });

    // ── Movable objects (pushable props + per-section reset trigger) ──
    const movableObjectBillboard = new MovableObjectBillboard(scene, camera, renderer.domElement);
    const movableObjectSystem = new MovableObjectSystem({
        scene,
        world,
        floorMaterial,
        wallMaterial,
        ballMaterial,
        player,
        ui: movableObjectBillboard,
    });

    // ── Dev tools panel (right-middle of screen) ──
    // Every feature in here (hotspot teleport, freeze, hotspot hide/restore/
    // force-trigger, mode switcher, Time Trial cheats) is off/inert until
    // explicitly toggled or pressed — never on by default.
    const devTools = new DevTools({ ballBody, hotspotSystem, respawnSystem, player, gameModeManager, camera });

    // ── Level ──
    loadLevel({ scene, ballBody, addTrimeshCollider, glowPath, brandGlow, playerFog, respawnSystem, hotspotSystem, gameModeManager, movableObjectSystem, hud, levelUrl });

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
            // The respawn/checkpoint trigger is the game's current hotspot —
            // lock out input briefly so the player doesn't immediately roll
            // straight back off the edge they just fell from.
            player.stick(HOTSPOT_STUCK_DURATION);
        });
        respawnSystem.updateFade(dt);

        ballMesh.position.copy(ballBody.position);
        ballMesh.quaternion.copy(ballBody.quaternion);

        audioManager.update(dt, ballBody, controls.keys);
        ballGlow.update(player.inputHoldTime);
        glowPath.update(clock.elapsedTime);
        brandGlow.update(clock.elapsedTime);
        playerFog.update(ballMesh.position);
        hotspotSystem.update(ballMesh.position);
        hotspotSystem.updateGlow(clock.elapsedTime);
        gameModeManager.update(dt, ballMesh.position, clock.elapsedTime);
        movableObjectSystem.update(ballMesh.position, clock.elapsedTime);
        // One frame behind (uses this frame's hotspot check, applied to next
        // frame's movement) — same lag every other hotspot-driven system here
        // already has, and not perceptible at 60fps.
        player.setHotspotActive(hotspotSystem.isActive);
        updateSunFollow(ballMesh.position);
        cameraController.update(ballMesh, player, hotspotSystem.activeHotspot, {
            lookAtPlayer: devTools.lookAtPlayer,
            position: devTools.manualCameraPosition,
            rotationRadians: devTools.getManualCameraRotationRadians(),
        });
        movableObjectBillboard.update(camera);
        updateSky(camera.position, dt);
        bloomRenderer.setHotspotActive(devTools.grayscalePreview || hotspotSystem.isActive);
        bloomRenderer.render();
        devTools.update();
    }

    animate();
}