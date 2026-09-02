import * as THREE from "three";
import { GLOW_COLOR, BLOOM_LAYER } from "./config.js";

// Visual-only markers (no physics), purely decorative — swap the
// placeholder prototype texture for a bright emissive core. The core mesh
// is flagged onto the bloom layer so BloomRenderer's isolated pass picks it
// up; a plain emissive material there is enough to read as "glowing" once
// selective bloom is applied on top.
//
// A Fresnel ("rim") shader is provided here too (createGlowShellMaterial)
// for anyone wanting to stack additional halo shells around the core mesh
// — alpha is driven by how edge-on each fragment is relative to the
// camera, so a shell fades from solid at the silhouette to transparent
// where it faces the viewer head-on, faking a soft glow falloff without
// relying purely on the bloom pass.
export function createGlowShellMaterial(color, baseOpacity, power) {
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

export class GlowPath {
    constructor() {
        this.glowMaterials = []; // { mat, role } — pulsed each frame
    }

    setup(glowRoot) {
        // Collect the target meshes into a plain array FIRST. Mutating the
        // scene graph while glowRoot.traverse() is still walking it can
        // cause newly-added nodes to be visited too — working from a
        // snapshot array avoids touching the tree until traversal is fully
        // done.
        const targets = [];
        glowRoot.traverse((child) => {
            if (child.isMesh) targets.push(child);
        });

        for (const child of targets) {
            // Strip the old prototype texture — the glow reads as pure
            // emissive light now, not a textured surface.
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
            this.glowMaterials.push({ mat: coreMat, role: "core" });
        }
    }

    // Like setup(), but for meshes that already carry an icon/line-art PNG
    // (transparent background, opaque white strokes) — e.g. the
    // "Brand"/"Branding" meshes. Instead of stripping the texture for a
    // flat full-quad emissive color, this keeps it as the alpha mask
    // (alphaTest discards the transparent background outright, rather than
    // blending it away, so the mesh's actual quad/plane shape never
    // renders) AND as the emissive mask (emissiveMap), so only the same
    // opaque strokes pick up the neon glow/bloom — everywhere the texture
    // is transparent stays completely unlit and out of the bloom pass.
    setupIcon(iconRoot, { alphaTest = 0.5 } = {}) {
        const targets = [];
        iconRoot.traverse((child) => {
            if (child.isMesh) targets.push(child);
        });

        for (const child of targets) {
            const iconTexture = child.material?.map || null;
            if (!iconTexture) {
                console.warn(`GlowPath.setupIcon: "${child.name}" has no texture map — skipping.`);
                continue;
            }

            const coreMat = new THREE.MeshStandardMaterial({
                map: iconTexture,
                color: GLOW_COLOR,
                transparent: false,
                alphaTest, // hard cutout — only the opaque line-art pixels render at all
                emissive: GLOW_COLOR,
                emissiveMap: iconTexture, // masks the glow to those same opaque pixels
                emissiveIntensity: 1.6,
                roughness: 0.3,
                metalness: 0,
                side: THREE.DoubleSide,
                toneMapped: false, // let emissive push past 1.0 and actually read as "hot"
            });
            child.material = coreMat;
            child.castShadow = false;
            child.receiveShadow = false;
            child.layers.enable(BLOOM_LAYER);
            this.glowMaterials.push({ mat: coreMat, role: "core" });
        }
    }

    // Swaps every glow material's color/emissive (core meshes, plus the
    // Fresnel shells' glowColor uniform, in case any are ever added here)
    // to `color` — used by GameModeManager to flip the path red while a
    // Collection Time Trial run is short on orbs, and back to GLOW_COLOR
    // once all orbs are in.
    setColor(color) {
        for (const { mat, role } of this.glowMaterials) {
            if (role === "core") {
                mat.color.set(color);
                mat.emissive.set(color);
            } else {
                mat.uniforms.glowColor.value.set(color);
            }
        }
    }

    // Gentle breathing pulse so the path doesn't sit static — noticeable
    // but not strobing. Each layer/role pulses over a different range so
    // the glow feels like it has depth rather than just uniformly
    // brightening/dimming.
    update(elapsed) {
        const pulse = 0.5 + Math.sin(elapsed * 2.2) * 0.5; // 0 -> 1
        for (const { mat, role } of this.glowMaterials) {
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
}