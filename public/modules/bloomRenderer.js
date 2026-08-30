import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { BLOOM_LAYER } from "./config.js";

// A plain single-pass UnrealBloomPass with threshold 0 blooms the entire
// frame — with this scene's light background, fog, and bright lights that
// means almost every pixel is above the threshold, so the whole window
// washes out to white. The fix is the standard three.js selective-bloom
// pattern: render the glow-path meshes on their own layer, bloom ONLY that
// layer in a separate offscreen composer, then composite the bloomed result
// back on top of the normally-lit full scene in a final pass. This keeps
// strength/radius/threshold exactly as requested while confining bloom to
// the neon path itself.
export class BloomRenderer {
    constructor(renderer, scene, camera) {
        this.renderer = renderer;
        this.scene = scene;
        this.camera = camera;

        this.bloomLayer = new THREE.Layers();
        this.bloomLayer.set(BLOOM_LAYER);

        this.darkMaterial = new THREE.MeshBasicMaterial({ color: "black" });
        this.materialCache = {};

        const renderScene = new RenderPass(scene, camera);

        const bloomPass = new UnrealBloomPass(
            new THREE.Vector2(window.innerWidth, window.innerHeight),
            0.6, // strength
            1,   // radius
            1    // threshold
        );

        // Offscreen composer: renders ONLY the bloom-layer objects
        // (everything else swapped to solid black first), then blooms that
        // isolated render.
        this.bloomComposer = new EffectComposer(renderer);
        this.bloomComposer.renderToScreen = false;
        this.bloomComposer.addPass(renderScene);
        this.bloomComposer.addPass(bloomPass);

        // Final composer: renders the full scene normally, then a mix
        // shader adds the bloomed texture from bloomComposer on top.
        const mixPass = new ShaderPass(
            new THREE.ShaderMaterial({
                uniforms: {
                    baseTexture: { value: null },
                    bloomTexture: { value: this.bloomComposer.renderTarget2.texture },
                },
                vertexShader: `
                    varying vec2 vUv;
                    void main() {
                        vUv = uv;
                        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                    }
                `,
                fragmentShader: `
                    uniform sampler2D baseTexture;
                    uniform sampler2D bloomTexture;
                    varying vec2 vUv;
                    void main() {
                        gl_FragColor = texture2D(baseTexture, vUv) + vec4(1.0) * texture2D(bloomTexture, vUv);
                    }
                `,
                defines: {},
            }),
            "baseTexture"
        );
        mixPass.needsSwap = true;

        this.composer = new EffectComposer(renderer);
        this.composer.addPass(renderScene);
        this.composer.addPass(mixPass);
        this.composer.addPass(new OutputPass());
    }

    _darkenNonBloomed(obj) {
        if (obj.isMesh && this.bloomLayer.test(obj.layers) === false) {
            this.materialCache[obj.uuid] = obj.material;
            obj.material = this.darkMaterial;
        }
    }

    _restoreMaterial(obj) {
        if (this.materialCache[obj.uuid]) {
            obj.material = this.materialCache[obj.uuid];
            delete this.materialCache[obj.uuid];
        }
    }

    setSize(width, height) {
        this.bloomComposer.setSize(width, height);
        this.composer.setSize(width, height);
    }

    render() {
        // The scene's background color and fog aren't meshes, so
        // _darkenNonBloomed() can't mask them — left alone, that light,
        // near-uniform backdrop fills almost the whole bloom-pass frame and
        // gets bloomed itself, then added on top of the final image. That's
        // what was washing the whole window white. Blank both out just for
        // the isolated bloom render, then restore them for the real one.
        const prevBackground = this.scene.background;
        const prevFog = this.scene.fog;
        this.scene.background = null;
        this.scene.fog = null;

        this.scene.traverse((obj) => this._darkenNonBloomed(obj));
        this.bloomComposer.render();
        this.scene.traverse((obj) => this._restoreMaterial(obj));

        this.scene.background = prevBackground;
        this.scene.fog = prevFog;

        this.composer.render();
    }
}
