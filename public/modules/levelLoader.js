import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { GLB_URL, WORLD_ROUGHNESS, WORLD_METALNESS, WORLD_CLEARCOAT, WORLD_CLEARCOAT_ROUGHNESS } from "./config.js";

// Loads the level GLB, builds physics colliders from its "CollisionShapes"
// node, sets up the neon glow path from its marker node, registers hotspot
// triggers from its "Hotspots" node, places the ball at "Spawn", and hands
// the loaded spawn position + the collision root off to the respawn system
// so it can compute fall bounds. (Ground fog is no longer authored
// per-level — see PlayerFog, which tracks the player's height everywhere
// instead of a fixed marker.)
export function loadLevel({ scene, ballBody, addTrimeshCollider, glowPath, playerFog, respawnSystem, hotspotSystem, hud }) {
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
            const hotspotsRoot = root.getObjectByName("Hotspots");

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

            respawnSystem.setLevelBounds(collisionRoot, spawnPos);
            playerFog.init(spawnPos);

            let colliderCount = 0;
            if (collisionRoot) {
                collisionRoot.traverse((child) => {
                    if (child.isMesh && child.geometry) {
                        addTrimeshCollider(child);
                        colliderCount++;
                        child.castShadow = true;
                        child.receiveShadow = true;
                        child.visible = true;

                        // Preserve original textures/maps, just upgrade the
                        // material properties.
                        const oldMat = child.material;

                        child.material = new THREE.MeshPhysicalMaterial({
                            map: oldMat.map || null,
                            color: oldMat.map ? 0xffffff : (oldMat.color || 0x2288ee), // white so texture isn't tinted
                            normalMap: oldMat.normalMap || null,
                            normalScale: oldMat.normalScale || undefined,
                            aoMap: oldMat.aoMap || null,
                            aoMapIntensity: oldMat.aoMapIntensity ?? 1,
                            emissive: oldMat.emissive || undefined,
                            emissiveMap: oldMat.emissiveMap || null,
                            emissiveIntensity: oldMat.emissiveIntensity ?? 1,
                            roughness: WORLD_ROUGHNESS,
                            metalness: WORLD_METALNESS,
                            clearcoat: WORLD_CLEARCOAT,
                            clearcoatRoughness: WORLD_CLEARCOAT_ROUGHNESS,
                        });

                        // aoMap requires a second UV set — copy it over if
                        // present.
                        if (oldMat.aoMap && child.geometry.attributes.uv2) {
                            child.material.aoMap = oldMat.aoMap;
                        }
                    }
                });
            } else {
                console.warn('No "CollisionShapes" node found — no colliders built.');
            }

            if (glowPathRoot) {
                glowPath.setup(glowPathRoot);
            } else {
                console.warn('No "GlowPath" node found — skipping neon path glow.');
            }

            if (hotspotsRoot) {
                hotspotSystem.setup(hotspotsRoot);
            } else {
                console.warn('No "Hotspots" node found — skipping hotspot triggers.');
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
}