import * as THREE from "three";
import { HOTSPOT_TRIGGER_RADIUS, GLOW_COLOR, BLOOM_LAYER, HOTSPOT_ENTER_RADIUS, HOTSPOT_EXIT_RADIUS, ASSET_BASE } from "./config.js";
import { fetchAssetBlobURL } from "./binaryAssetLoader.js";

// Maps a hotspot's world node name (as authored in the level GLB, under a
// "Hotspots" root — same pattern as "CollisionShapes"/"GlowPath") to the
// popup content shown when the player rolls over it. `className` lets each
// hotspot use a completely different layout, not just different text — see
// the .hotspot-content-1 / .hotspot-content-2 rules in index.html. Add an
// entry here for every new "Hotspot_N" node you author in the level.
const HOTSPOT_CONTENT = {
    Hotspot_1: {
        className: "hotspot-content-1",
        render: () => `
        <div class="container">
        <div class="start_card">
            <h5>Hello, World!</h5>
            <br>
            <h1>Maze-Ball</h1>
            <p>A Project by Drei</p>
            <p>Inspired by Netlify's 5 mil+ celebration</p>
        </div>

        <div class="start_menu_container">
            <div class="menu_header">
                <p>Select A Mode</p>
                
                <div class="slider_buttons">
                    <button class="mode_selector_button prev">
                        <svg width="100%" height="100%" viewBox="0 0 24 24" fill="none"
                            xmlns="http://www.w3.org/2000/svg">
                            <path d="M15 18L9 12L15 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"
                                stroke-linejoin="round" />
                        </svg>
                        <span>Prev Mode</span>
                    </button>
                    <button class="mode_selector_button next">
                        <span>Next Mode</span>
                        <svg width="100%" height="100%" viewBox="0 0 24 24" fill="none"
                            xmlns="http://www.w3.org/2000/svg">
                            <path d="M9 18L15 12L9 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"
                                stroke-linejoin="round" />
                        </svg>
                    </button>
                </div>
            </div>

            <br>

            <!-- viewport: clips the track -->
            <div class="start_menu_slider">
                <!-- track: holds all slides side by side, gets translated -->
                <div class="start_menu_track">

                    <div class="start_menu">
                        <img data-b64-src="FreeRoam.png" data-b64-type="image/png" alt="">
                        <br>
                        <h1>Free Roam</h1>
                        <p>Explore the map at your own pace and look at how the development process of the project went. No objectives. </p>
                        <br>
                        <button data-mode="freeroam">Select</button>
                    </div>

                    <div class="start_menu">
                        <video
                            data-b64-src="Speedrun.mp4"
                            data-b64-type="video/mp4"
                            autoplay
                            muted
                            loop
                            playsinline
                            style="width: 100%; height: 55%; object-fit: cover;"
                            ></video>
                        <br>
                        <h1>Speedrun</h1>
                        <p>Race from the gate to the End marker as fast as you can.</p>
                        <i><b>(My fastest time was 16.62 seconds)</b></i>
                        <br>
                        
                        <button data-mode="speedrun">Select</button>
                    </div>

                    <div class="start_menu">
                        <video
                            data-b64-src="TimeTrial.mp4"
                            data-b64-type="video/mp4"
                            autoplay
                            muted
                            loop
                            playsinline
                            style="width: 100%; height: 55%; object-fit: cover;"
                            ></video>
                        <br>
                        <h1>Collection Time Trial</h1>
                        <p>Collect all 20 glowing orbs and reach the End marker before the 2-minute and 30-second clock runs out.</p>
                        <i><b>(My fastest time was 57.18 seconds)</b></i>
                        <br>
                        <button data-mode="timetrial">Select</button>
                    </div>

                    <div class="start_menu coming_soon">
                        <br>
                        <br>
                        <br>
                        <br>
                        <br>
                        <br>
                        <br>
                        <br>
                        <br>
                        <br>
                        <p><b>Coming Soon</b></p>
                        <h1>Spawn Chase</h1>
                        <p>Find and collect all 10 orbs as quickly as possible—one at a time within 6 minutes. Each orb only appears after the last has been captured, so stay alert and keep moving.</p>
                    </div>

                    <div class="start_menu coming_soon">
                        <br>
                        <br>
                        <br>
                        <br>
                        <br>
                        <br>
                        <br>
                        <br>
                        <br>
                        <br>
                        <p><b>Coming Soon</b></p>
                        <h1>Collect Them all</h1>
                        <p>There are 100+ orbs scatered across the map. Find them and collect them all as fas as you can. The faste the more point you earn.</p>
                    </div>

                </div>
            </div>
        </div>
    </div>
        `,
        // Runs once right after this markup is injected into the popup —
        // same goToSlide logic as index.html's inline <script>, just
        // scoped to popupEl since innerHTML gives us a fresh DOM each
        // time the hotspot is entered. `context` is HotspotSystem's own
        // context object (see its constructor) — this is how the mode
        // buttons reach GameModeManager without HOTSPOT_CONTENT needing a
        // direct import of it.
        init: (popupEl, context = {}) => {
            // The <img>/<video> tags above only carry a data-b64-src
            // filename (see the comment on binaryAssetLoader.js for why a
            // plain src="/assets/..." would come back truncated). Resolve
            // each one to a decoded Blob URL now that they're real DOM
            // elements. Runs async/best-effort — a slow-loading thumbnail
            // just pops in a moment late rather than blocking the popup.
            popupEl.querySelectorAll("[data-b64-src]").forEach((el) => {
                const file = el.getAttribute("data-b64-src");
                const type = el.getAttribute("data-b64-type");
                fetchAssetBlobURL(ASSET_BASE + file, type)
                    .then((blobUrl) => {
                        el.src = blobUrl;
                        if (el.tagName === "VIDEO") el.load();
                    })
                    .catch((err) => console.error(`Failed to load ${file}:`, err));
            });

            const track = popupEl.querySelector(".start_menu_track");
            const slides = popupEl.querySelectorAll(".start_menu");
            const prevBtn = popupEl.querySelector(".slider_buttons .prev");
            const nextBtn = popupEl.querySelector(".slider_buttons .next");
            const currentModeLabel = popupEl.querySelector("#current-mode-label");

            // const MODE_NAMES = { freeroam: "Free Roam", speedrun: "Speedrun", timetrial: "Collection Time Trial" };
            // if (currentModeLabel) {
            //     const current = context.getCurrentMode ? context.getCurrentMode() : null;
            //     currentModeLabel.textContent = current
            //         ? `Current mode: ${MODE_NAMES[current] || current}`
            //         : "No mode selected yet";
            // }

            let currentIndex = 0;
            const goToSlide = (index) => {
                currentIndex = (index + slides.length) % slides.length;
                track.style.transform = `translateX(-${currentIndex * 100}%)`;
            };

            prevBtn.addEventListener("click", () => goToSlide(currentIndex - 1));
            nextBtn.addEventListener("click", () => goToSlide(currentIndex + 1));

            popupEl.querySelectorAll("button[data-mode]").forEach((btn) => {
                btn.addEventListener("click", () => {
                    if (context.onSelectMode) context.onSelectMode(btn.dataset.mode);
                });
            });
        },
    },
    Hotspot_2: {
        className: "hotspot-content-2",
        render: () => `<div>Content 2</div>`,
    },
    Hotspot_3: {
        className: "hotspot-content-2",
        render: () => `<div>Content 3</div>`,
    },
    Hotspot_4: {
        className: "hotspot-content-2",
        render: () => `<div>Content 4</div>`,
    },
    Hotspot_5: {
        className: "hotspot-content-2",
        render: () => `<div>Content 5</div>`,
    },
};

// Detects when the ball enters/exits a level-authored hotspot trigger and
// owns the popup DOM element that displays each hotspot's content. Movement
// itself isn't touched here — on entry it just calls the optional onEnter
// callback (typically player.stick(...)), leaving PlayerController to own
// the actual stuck-timer/wobble-to-a-stop effect.
//
// Every registered hotspot node also gets the same pulsating blue-neon
// bloom treatment as GlowPath (same emissive material setup, same BLOOM_LAYER
// flag, same breathing-pulse curve), so the markers themselves are visible
// in the level as glowing beacons rather than invisible trigger volumes.
export class HotspotSystem {
    // `context` is handed straight through to each hotspot's content.init()
    // (see Hotspot_1 above) — GameModeManager plugs onSelectMode/
    // getCurrentMode in here via game.js so the mode-select menu can call
    // back into it without HOTSPOT_CONTENT importing it directly.
    constructor(popupEl, onEnter, context = {}) {
        this.popupEl = popupEl;
        this.onEnter = onEnter;
        this.context = context;
        this.hotspots = []; // { name, position, content, node, hidden }
        this.activeHotspot = null; // currently-inside hotspot, or null
        this.glowMaterials = []; // pulsed each frame, same pattern as GlowPath
    }

    // Called once after the level loads, with the "Hotspots" root node (or
    // null if the level has none). Registers every child whose name has a
    // matching HOTSPOT_CONTENT entry; anything else under the node is
    // ignored so unrelated helper nodes don't need special-casing.
    setup(hotspotsRoot) {
        if (!hotspotsRoot) return;

        hotspotsRoot.traverse((child) => {
            if (child === hotspotsRoot) return;
            const content = HOTSPOT_CONTENT[child.name];
            if (!content) return;

            const position = new THREE.Vector3();
            child.getWorldPosition(position);
            this.hotspots.push({ name: child.name, position, content, node: child, hidden: false });

            this._setupGlow(child);
        });
    }

    // Swaps every mesh under `node` (or node itself, if it's already a
    // mesh) onto the same emissive/bloom material GlowPath uses, so the
    // hotspot marker reads as the identical blue neon glow.
    _setupGlow(node) {
        const meshes = [];
        if (node.isMesh) {
            meshes.push(node);
        } else {
            node.traverse((child) => {
                if (child.isMesh) meshes.push(child);
            });
        }

        for (const mesh of meshes) {
            const mat = new THREE.MeshStandardMaterial({
                color: GLOW_COLOR,
                emissive: GLOW_COLOR,
                emissiveIntensity: 1.6, // overwritten every frame by updateGlow()
                roughness: 0.3,
                metalness: 0,
                toneMapped: false, // let emissive push past 1.0 and actually read as "hot"
            });
            mesh.material = mat;
            mesh.castShadow = false;
            mesh.receiveShadow = false;
            mesh.layers.enable(BLOOM_LAYER); // feeds BloomRenderer's isolated pass
            this.glowMaterials.push(mat);
        }
    }

    // Gentle breathing pulse — same curve/range as GlowPath.update() — so
    // hotspot markers pulse in lockstep with the neon path rather than out
    // of sync with a different rhythm. Call every frame regardless of
    // whether any hotspot is currently active; the markers glow always.
    updateGlow(elapsed) {
        const pulse = 0.5 + Math.sin(elapsed * 2.2) * 0.5; // 0 -> 1
        const intensity = 2.2 + pulse * 1.2; // ~2.2–3.4, matches GlowPath's "core" role
        for (const mat of this.glowMaterials) {
            mat.emissiveIntensity = intensity;
        }
    }

    // Called every frame with the ball's live world position. Handles both
    // the enter and exit edges; only one hotspot can be active at a time.
    // Hidden hotspots (see hideAllExcept below) are skipped entirely, so
    // they can't be entered while suppressed for a Speedrun/Time Trial run.
    update(ballPosition) {
        if (this.activeHotspot) {
            const dist = ballPosition.distanceTo(this.activeHotspot.position);
            if (dist > HOTSPOT_EXIT_RADIUS || this.activeHotspot.hidden) {
                this._exit();
            }
        }

        if (!this.activeHotspot) {
            for (const hotspot of this.hotspots) {
                if (hotspot.hidden) continue;
                if (ballPosition.distanceTo(hotspot.position) <= HOTSPOT_ENTER_RADIUS) {
                    this._enter(hotspot);
                    break;
                }
            }
        }
    }

    // Hides every registered hotspot except `keepName` (GameModeManager
    // passes HOTSPOT_1_NAME) — used while a timed Speedrun/Time Trial run is
    // active, so only the mode-select marker stays interactable. Force-exits
    // the active hotspot immediately if it's one of the ones being hidden,
    // rather than waiting for the ball to wander back out of range.
    hideAllExcept(keepName) {
        for (const hotspot of this.hotspots) {
            hotspot.hidden = hotspot.name !== keepName;
            if (hotspot.node) hotspot.node.visible = !hotspot.hidden;
        }
        if (this.activeHotspot && this.activeHotspot.hidden) {
            this._exit();
        }
    }

    // Brings every hotspot back — called on selecting Free Roam, or when a
    // Speedrun/Time Trial run ends (success, failure, or is abandoned).
    restoreAll() {
        for (const hotspot of this.hotspots) {
            hotspot.hidden = false;
            if (hotspot.node) hotspot.node.visible = true;
        }
    }

    _enter(hotspot) {
        this.activeHotspot = hotspot;
        this.popupEl.innerHTML = hotspot.content.render();
        this.popupEl.className = hotspot.content.className;
        void this.popupEl.offsetWidth;
        this.popupEl.classList.add("visible");

        if (hotspot.content.init) hotspot.content.init(this.popupEl, this.context);

        if (this.onEnter) this.onEnter(hotspot);
    }

    _exit() {
        this.activeHotspot = null;
        this.popupEl.classList.remove("visible");
    }

    get isActive() {
        return this.activeHotspot !== null;
    }
}