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
import { FpsCounter } from "./fpsCounter.js";
import { loadLevel } from "./levelLoader.js";
import { LoadingScreen } from "./loadingScreen.js";
import { PlayerEntrance } from "./playerEntrance.js";
import { BALL_RADIUS, HOTSPOT_STUCK_DURATION, GLB_URL } from "./config.js";

// Boots the whole game — scene, physics, ball, camera, hotspots, game
// modes, dev tools, and the level itself. Used by both the main game
// (game.js, default maze GLB) and the about page (about.js), which is
// identical in every way except which world it loads — see `levelUrl`.
export function startGame({ levelUrl = GLB_URL } = {}) {
    const hud = document.getElementById("hud");
    const fadeOverlay = document.getElementById("fade-overlay");
    const hotspotPopup = document.getElementById("hotspot-popup");

    // ── Loading screen ──
    // Covers the whole page from the very first frame until both the level
    // and the ball model have finished loading — see the ballReady/
    // levelReady handshake down near loadLevel() below.
    const loadingScreen = new LoadingScreen();

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
    const { ballMesh, ballBody, ballGlow, ready: ballReady } = createBall(scene, world, ballMaterial);

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

    // ── Spawn-entrance animation ──
    // Hides the ball and freezes input immediately — well before the level
    // or ball model have actually finished loading — so there's nothing
    // to see or move until the loading screen clears and the beam-drop
    // sequence below reveals the player. See the ballReady/levelReady
    // handshake near loadLevel() for exactly when that happens.
    const playerEntrance = new PlayerEntrance(scene);
    playerEntrance.hidePlayer(ballMesh, player);

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
        ui: movableObjectBillboard,
    });

    // ── Dev tools panel (right-middle of screen) ──
    // Every feature in here (hotspot teleport, freeze, hotspot hide/restore/
    // force-trigger, mode switcher, Time Trial cheats) is off/inert until
    // explicitly toggled or pressed — never on by default.
    const devTools = new DevTools({ ballBody, hotspotSystem, respawnSystem, player, gameModeManager, camera });

    // ── FPS readout (top-right) ──
    const fpsCounter = new FpsCounter();

    // ── Level ──
    // The world (level GLB) and the ball (its own GLB, kicked off back in
    // createBall()) load in parallel — the loading screen stays up and the
    // player stays hidden/frozen (see playerEntrance.hidePlayer() above)
    // until BOTH are ready, at which point the loading screen fades out
    // and the beam-drop entrance plays at the level's actual spawn point.
    let ballAssetReady = false;
    let levelAssetReady = false;
    let levelSpawnPos = null;

    function tryRevealPlayer() {
        if (!ballAssetReady || !levelAssetReady) return;
        loadingScreen.hide();
        if (levelSpawnPos) {
            playerEntrance.play(levelSpawnPos);
        } else {
            // Level failed to load — nothing sensible to play the beam
            // at, so just reveal the player where it is rather than
            // leaving it invisible/frozen forever.
            ballMesh.visible = true;
            player.setFrozen(false);
        }
    }

    ballReady.then(() => {
        ballAssetReady = true;
        tryRevealPlayer();
    });

    loadLevel({
        scene, ballBody, addTrimeshCollider, glowPath, brandGlow, playerFog,
        respawnSystem, hotspotSystem, gameModeManager, movableObjectSystem, hud, levelUrl,
        onReady: (spawnPos) => {
            levelAssetReady = true;
            levelSpawnPos = spawnPos;
            tryRevealPlayer();
        },
    });

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
        const rawDt = clock.getDelta();
        const dt = Math.min(rawDt, 0.05);
        // Fed the RAW delta, not the clamped one above — see fpsCounter.js's
        // comment on why a real hitch shouldn't be hidden behind that cap.
        fpsCounter.update(rawDt);

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
        playerEntrance.update(dt, clock.elapsedTime);
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