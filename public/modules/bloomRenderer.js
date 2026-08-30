import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { BLOOM_LAYER, BALL_COLOR_LAYER, HOTSPOT_GRAYSCALE_BLEND } from "./config.js";

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

        // ── Hotspot environment grayscale ──
        // grayAmount eases toward targetGrayAmount every frame (see
        // setHotspotActive/render below) so the color drain reads as a
        // smooth transition rather than a hard cut.
        this.grayAmount = 0;
        this.targetGrayAmount = 0;

        // A same-size offscreen render of JUST the ball (everything else
        // pitch black), used as a mask by grayscalePass below to decide
        // which pixels are exempt from desaturation. White-flat material
        // is enough — we only ever read its luminance/red channel.
        this.maskMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });
        this.maskTarget = new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight);

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

        // Desaturates the composited frame toward grayscale by
        // `grayAmount`, except where maskTexture marks a pixel as
        // belonging to the ball (mix back to the original color there) —
        // so the ball stays fully colored while the rest of the frame
        // fades to grey. Runs after mixPass so it's operating on the final
        // (bloom-included) color, and before OutputPass's color-space
        // conversion.
        this.grayscalePass = new ShaderPass(
            new THREE.ShaderMaterial({
                uniforms: {
                    tDiffuse: { value: null },
                    maskTexture: { value: this.maskTarget.texture },
                    grayAmount: { value: 0 },
                },
                vertexShader: `
                    varying vec2 vUv;
                    void main() {
                        vUv = uv;
                        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                    }
                `,
                fragmentShader: `
                    uniform sampler2D tDiffuse;
                    uniform sampler2D maskTexture;
                    uniform float grayAmount;
                    varying vec2 vUv;
                    void main() {
                        vec4 base = texture2D(tDiffuse, vUv);
                        float isBall = texture2D(maskTexture, vUv).r;
                        float luma = dot(base.rgb, vec3(0.299, 0.587, 0.114));
                        vec3 desaturated = mix(base.rgb, vec3(luma), grayAmount);
                        vec3 finalColor = mix(desaturated, base.rgb, isBall);
                        gl_FragColor = vec4(finalColor, base.a);
                    }
                `,
            })
        );

        this.composer = new EffectComposer(renderer);
        this.composer.addPass(renderScene);
        this.composer.addPass(mixPass);
        this.composer.addPass(this.grayscalePass);
        this.composer.addPass(new OutputPass());
    }

    // Called every frame (e.g. with HotspotSystem.isActive) to set which
    // way the grayscale transition should be easing.
    setHotspotActive(active) {
        this.targetGrayAmount = active ? 1 : 0;
    }

    // Renders a same-size mask of just the ball (white ball, black
    // everything else) into maskTarget, for grayscalePass to sample.
    // Restricting the camera to BALL_COLOR_LAYER and overriding every
    // material to a flat white is the cheapest way to get a clean mask
    // without hand-tracking which meshes are "the ball".
    _renderColorMask() {
        const prevBackground = this.scene.background;
        const prevFog = this.scene.fog;
        const prevOverride = this.scene.overrideMaterial;
        const prevLayers = this.camera.layers.mask;

        this.scene.background = null;
        this.scene.fog = null;
        this.scene.overrideMaterial = this.maskMaterial;
        this.camera.layers.set(BALL_COLOR_LAYER);

        this.renderer.setRenderTarget(this.maskTarget);
        this.renderer.setClearColor(0x000000, 1);
        this.renderer.clear();
        this.renderer.render(this.scene, this.camera);
        this.renderer.setRenderTarget(null);

        this.scene.background = prevBackground;
        this.scene.fog = prevFog;
        this.scene.overrideMaterial = prevOverride;
        this.camera.layers.mask = prevLayers;
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
        this.maskTarget.setSize(width, height);
    }

    render() {
        // Ease toward the target every frame (per-frame blend, not
        // dt-scaled — same style as CameraController's hotspot blend) so
        // activating/leaving a hotspot fades the environment in/out of
        // grayscale smoothly instead of snapping.
        this.grayAmount += (this.targetGrayAmount - this.grayAmount) * HOTSPOT_GRAYSCALE_BLEND;
        if (Math.abs(this.grayAmount - this.targetGrayAmount) < 0.001) {
            this.grayAmount = this.targetGrayAmount;
        }
        this.grayscalePass.material.uniforms.grayAmount.value = this.grayAmount;

        // Only pay for the extra mask render while it can actually affect
        // the image — at grayAmount 0 the shader's mix() collapses to the
        // original color regardless of the (possibly stale) mask.
        if (this.grayAmount > 0.001) {
            this._renderColorMask();
        }

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