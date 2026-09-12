import * as THREE from "three";
import { HOTSPOT_TRIGGER_RADIUS, GLOW_COLOR, BLOOM_LAYER, HOTSPOT_ENTER_RADIUS, HOTSPOT_EXIT_RADIUS, AUDIO_BASE, resolveAssetUrl } from "./config.js";
import { fetchAssetBlobURL } from "./binaryAssetLoader.js";

// Shared, module-level narration state — deliberately NOT scoped to a
// single popup. A ".Record_player" clip is now allowed to keep playing
// after the player rolls out of range and the popup that started it is
// torn down, so the "currently playing" audio has to live somewhere that
// outlives any one popup instance. Only one narration clip plays at a
// time across every hotspot.
const narration = {
    audio: null,       // the currently loaded/playing <audio>, or null
    hotspotName: null, // which Hotspot_N node "owns" it
    cancelBtn: null,   // lazily-created floating stop button (bottom-left)
};

// Tracks whichever hotspot the ball is currently inside, kept in sync by
// HotspotSystem._enter()/_exit() below. Used only to decide whether the
// floating cancel button should be visible — narration.hotspotName is the
// clip's owner, this is where the player actually is right now.
let currentActiveHotspotName = null;

// Set by HotspotSystem's constructor from context.onNarrationStateChange
// (main.js wires this to BackgroundMusicManager.setDucked) — module-level
// since narration playback itself is module-level state, not per-instance.
// Only one HotspotSystem is ever constructed per page, so this is safe.
let narrationChangeCallback = null;

function getCancelButton() {
    if (narration.cancelBtn) return narration.cancelBtn;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = "narration-cancel-button";
    btn.textContent = "Stop Narration";
    Object.assign(btn.style, {
        position: "fixed",
        left: "20px",
        bottom: "20px",
        zIndex: "1000",
        display: "none",
        alignItems: "center",
        gap: "8px",
        padding: "10px 18px",
        borderRadius: "999px",
        border: "1px solid rgba(255,255,255,0.25)",
        background: "rgba(15,15,20,0.82)",
        color: "#fff",
        fontFamily: "inherit",
        fontSize: "14px",
        fontWeight: "600",
        letterSpacing: "0.01em",
        cursor: "pointer",
        boxShadow: "0 6px 18px rgba(0,0,0,0.35)",
        backdropFilter: "blur(6px)",
    });
    btn.addEventListener("click", () => stopNarration());
    document.body.appendChild(btn);
    narration.cancelBtn = btn;
    return btn;
}

// Shows/hides the floating cancel button based on current state: it should
// only be visible while a clip is actively playing (not paused) AND the
// player is somewhere other than that clip's own hotspot — right at the
// hotspot, the in-popup Record_player button already offers play/pause.
function refreshCancelButtonVisibility() {
    const shouldShow =
        !!narration.audio &&
        !narration.audio.paused &&
        narration.hotspotName !== currentActiveHotspotName;
    getCancelButton().style.display = shouldShow ? "flex" : "none";
}

// Single choke point for "narration playback state may have changed" —
// call this instead of refreshCancelButtonVisibility() directly whenever
// narration.audio starts, pauses, resumes, ends, or is cleared. Updates
// the floating cancel button AND tells main.js (via the
// onNarrationStateChange context callback) whether to duck the background
// music, so the two never drift out of sync.
function onNarrationChanged() {
    refreshCancelButtonVisibility();
    if (narrationChangeCallback) {
        narrationChangeCallback(!!narration.audio && !narration.audio.paused);
    }
}

// Fully stops and clears whatever narration clip is currently active —
// used by the floating cancel button, and internally whenever a different
// hotspot's clip is about to start.
function stopNarration() {
    if (narration.audio) {
        narration.audio.pause();
        narration.audio.currentTime = 0;
    }
    narration.audio = null;
    narration.hotspotName = null;
    onNarrationChanged();
}

// Wires a popup's ".Record_player" button (see Hotspot_2-5 below) to fetch
// and play its narration clip — e.g. "H2.mp3" -> AUDIO_BASE + "H2.mp3.b64",
// same base64-sidecar pipeline as the images/videos above.
//
// Behavior:
// - Clicking this hotspot's own button while its clip is already loaded
//   just toggles play/pause (no re-fetch).
// - Clicking it while a DIFFERENT hotspot's clip is playing cancels that
//   clip first, then fetches and starts this one.
// - The clip is intentionally NOT tied to popupEl/this hotspot's presence —
//   it keeps playing after the player walks away (see `narration` above),
//   surfaced instead via the floating cancel button.
function setupRecordPlayer(popupEl, file, hotspotName) {
    const btn = popupEl.querySelector(".Record_player");
    if (!btn || !file) return;

    let loading = false;

    btn.addEventListener("click", async () => {
        if (loading) return;

        // Same clip already active for this hotspot -> just toggle it.
        if (narration.audio && narration.hotspotName === hotspotName) {
            if (narration.audio.paused) {
                narration.audio.play();
            } else {
                narration.audio.pause();
            }
            onNarrationChanged();
            return;
        }

        // A different hotspot's clip is currently playing -> cancel it
        // before starting this one.
        if (narration.audio) {
            stopNarration();
        }

        loading = true;
        btn.disabled = true;
        try {
            const blobUrl = await fetchAssetBlobURL(AUDIO_BASE + file, "audio/mpeg");
            const audio = new Audio(blobUrl);
            narration.audio = audio;
            narration.hotspotName = hotspotName;
            audio.addEventListener("ended", () => {
                if (narration.audio === audio) {
                    narration.audio = null;
                    narration.hotspotName = null;
                }
                onNarrationChanged();
            });
            await audio.play();
            onNarrationChanged();
        } catch (err) {
            console.error(`Failed to load hotspot audio ${file}:`, err);
        } finally {
            loading = false;
            btn.disabled = false;
        }
    });
}

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
            <h1>Project Balls</h1>
            <p>A Project by Drei</p>
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
                        <i><b>(My fastest time was 16.01 seconds)</b></i>
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
                        <p><b>Under Development</b></p>
                        <h1>2-Player rush</h1>
                        <p>Compete with your freinds by collecting 20 orbs scattered throughout the map. The firts one to collect and bring and reach the end checkpoint wins. </p>
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
                fetchAssetBlobURL(resolveAssetUrl(file), type)
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
        render: () => `
    <div class="main_wrapper">
        <h1>Hello, World!</h1>

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
        <br>

        <div class="slider_viewport">
            <div class="slider">
                <div class="slide_1 slide">
                    <img data-b64-src="FreeRoam.png" data-b64-type="image/png" alt="">
                </div>
                <div class="slide_2 slide">
                    <p>This project was created to test out BSL capabilities by creating a lightweight custom HTTP server written from scratch in the Bonezegei Scripting Language (BSL). </p>
                    <br>
                    <button class="Record_player" id="intro_audio">
                        <svg class="w-10 h-10 text-gray-800 dark:text-white" aria-hidden="true"
                            xmlns="http://www.w3.org/2000/svg" width="34" height="34" fill="currentColor"
                            viewBox="0 0 24 24">
                            <path fill-rule="evenodd"
                                d="M8.6 5.2A1 1 0 0 0 7 6v12a1 1 0 0 0 1.6.8l8-6a1 1 0 0 0 0-1.6l-8-6Z"
                                clip-rule="evenodd" />
                        </svg>
                    </button>
                </div>
            </div>
        </div>
    </div>

    <!--div class="side_wrapper">
        <div class="side">
            <h2>HOT</h2>
            <h3>SPOT</h3>
            <h1>2</h1>
        </div>
    </div-->
    `,
        // Same b64-resolution pattern as Hotspot_1. Slider has three ways to
        // advance: the .slider_buttons prev/next pair up top, and the single
        // slide_next_button inside slide_2 — all three drive the same
        // goToSlide() so they stay in sync regardless of which one is used.
        init: (popupEl, context = {}) => {
            popupEl.querySelectorAll("[data-b64-src]").forEach((el) => {
                const file = el.getAttribute("data-b64-src");
                const type = el.getAttribute("data-b64-type");
                fetchAssetBlobURL(resolveAssetUrl(file), type)
                    .then((blobUrl) => {
                        el.src = blobUrl;
                        if (el.tagName === "VIDEO") el.load();
                    })
                    .catch((err) => console.error(`Failed to load ${file}:`, err));
            });

            const slider = popupEl.querySelector(".slider");
            const slides = popupEl.querySelectorAll(".slide");
            const nextBtn = popupEl.querySelector(".slide_next_button");
            const prevModeBtn = popupEl.querySelector(".slider_buttons .prev");
            const nextModeBtn = popupEl.querySelector(".slider_buttons .next");

            let currentIndex = 0;
            const goToSlide = (index) => {
                currentIndex = (index + slides.length) % slides.length;
                slider.style.transform = `translateX(-${currentIndex * 100}%)`;
            };

            if (nextBtn) {
                nextBtn.addEventListener("click", () => goToSlide(currentIndex + 1));
            }
            if (prevModeBtn) {
                prevModeBtn.addEventListener("click", () => goToSlide(currentIndex - 1));
            }
            if (nextModeBtn) {
                nextModeBtn.addEventListener("click", () => goToSlide(currentIndex + 1));
            }

            setupRecordPlayer(popupEl, "H2.mp3", "Hotspot_2");
        },
    },
    Hotspot_3: {
        className: "hotspot-content-3",
        render: () => `
    <div class="main_wrapper">
        <h1>My Inspiration</h1>

        <div class="slider_buttons">
            <button class="mode_selector_button prev" type="button">
                <svg width="100%" height="100%" viewBox="0 0 24 24" fill="none"
                    xmlns="http://www.w3.org/2000/svg">
                    <path d="M15 18L9 12L15 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"
                        stroke-linejoin="round" />
                </svg>
                <span>Prev</span>
            </button>
            <button class="mode_selector_button next" type="button">
                <span>Next</span>
                <svg width="100%" height="100%" viewBox="0 0 24 24" fill="none"
                    xmlns="http://www.w3.org/2000/svg">
                    <path d="M9 18L15 12L9 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"
                        stroke-linejoin="round" />
                </svg>
            </button>
        </div>

        <br>

        <div class="slider_viewport">
            <div class="slider">
                <div class="slide_1 slide">
                    <img data-b64-src="Hotspot_Head_3.png" data-b64-type="image/png" alt="">
                </div>

                <div class="slide_2 slide">
                    <p>
                        I was first inspired by the great award winning <a href="https://bruno-simon.com" target="_blank" rel="noopener noreferrer">Bruno Simon</a> for choosing to create a 3D Web based experience and <a href="https://5-million-devs.netlify.com/" target="_blank" rel="noopener noreferrer">Netlify's 5M+ dev celebrations ball game</a> for the main movement and map layout. The game design was inspired by the generic Roblox Obby style of gameplay. With the Free Roam mode inspired by Portal (Valve).
                    </p>

                    <br>

                    <button class="Record_player" type="button" id="inspo_audio"">
                        <svg width="34" height="34" fill="currentColor" viewBox="0 0 24 24">
                            <path fill-rule="evenodd"
                                d="M8.6 5.2A1 1 0 0 0 7 6v12a1 1 0 0 0 1.6.8l8-6a1 1 0 0 0 0-1.6l-8-6Z"
                                clip-rule="evenodd" />
                        </svg>
                    </button>
                </div>
            </div>
        </div>
    </div>
    `,
        // Same b64-resolution + slider pattern as Hotspot_1/Hotspot_2. Only
        // one image needs resolving here (FreeRoam.png); the "Record_player"
        // button doesn't play anything yet in this popup so it's left as a
        // static hook for now, same as the source test page.
        init: (popupEl, context = {}) => {
            popupEl.querySelectorAll("[data-b64-src]").forEach((el) => {
                const file = el.getAttribute("data-b64-src");
                const type = el.getAttribute("data-b64-type");
                fetchAssetBlobURL(resolveAssetUrl(file), type)
                    .then((blobUrl) => {
                        el.src = blobUrl;
                        if (el.tagName === "VIDEO") el.load();
                    })
                    .catch((err) => console.error(`Failed to load ${file}:`, err));
            });

            const slider = popupEl.querySelector(".slider");
            const slides = popupEl.querySelectorAll(".slide");
            const prevBtn = popupEl.querySelector(".slider_buttons .prev");
            const nextBtn = popupEl.querySelector(".slider_buttons .next");

            let currentIndex = 0;
            const goToSlide = (index) => {
                currentIndex = (index + slides.length) % slides.length;
                slider.style.transform = `translateX(-${currentIndex * 100}%)`;
            };

            if (prevBtn) prevBtn.addEventListener("click", () => goToSlide(currentIndex - 1));
            if (nextBtn) nextBtn.addEventListener("click", () => goToSlide(currentIndex + 1));

            goToSlide(0);

            setupRecordPlayer(popupEl, "H3.mp3", "Hotspot_3");
        },
    },
    Hotspot_4: {
        className: "hotspot-content-4",
        render: () => `
    <div class="main_wrapper">
        <h1>&lt; Dev Note /&gt;</h1>

        <div class="slider_buttons">
            <button class="mode_selector_button prev" type="button">
                <svg width="100%" height="100%" viewBox="0 0 24 24" fill="none"
                    xmlns="http://www.w3.org/2000/svg">
                    <path d="M15 18L9 12L15 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"
                        stroke-linejoin="round" />
                </svg>
                <span>Prev</span>
            </button>
            <button class="mode_selector_button next" type="button">
                <span>Next</span>
                <svg width="100%" height="100%" viewBox="0 24 24" fill="none"
                    xmlns="http://www.w3.org/2000/svg">
                    <path d="M9 18L15 12L9 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"
                        stroke-linejoin="round" />
                </svg>
            </button>
        </div>

        <br>

        <div class="slider_viewport">
            <div class="slider">
                <div class="slide_1 slide">
                    <img data-b64-src="Hotspot_Head_4.jpg" data-b64-type="image/png" alt="">
                </div>

                <div class="slide_2 slide">
                    <p>
                        The Development process for the project took a total of 9 hours spread over a week of development. While the game was built on standard JavaScript, the BSL being used on the backend had to manually pick out the file name from the raw text of each browser request, since it doesn't have a built-in tool that understands web requests for you.
                    </p>

                    <br>

                    <button class="Record_player" type="button" id="devNotes_audio">
                        <svg width="34" height="34" fill="currentColor" viewBox="0 0 24 24">
                            <path fill-rule="evenodd"
                                d="M8.6 5.2A1 1 0 0 0 7 6v12a1 1 0 0 0 1.6.8l8-6a1 1 0 0 0 0-1.6l-8-6Z"
                                clip-rule="evenodd" />
                        </svg>
                    </button>
                </div>
            </div>
        </div>
    </div>
    `,
        // Same b64-resolution + slider pattern as Hotspot_1/2/3. Only the
        // slide_1 thumbnail needs resolving (Hotspot_Head_4.jpg). Note the
        // source .jpg file is passed with data-b64-type="image/png" in the
        // original markup — kept as-is here, but worth checking whether
        // that's intentional (e.g. server stores everything as PNG-encoded
        // regardless of file extension) or a mismatch to fix at the source.
        init: (popupEl, context = {}) => {
            popupEl.querySelectorAll("[data-b64-src]").forEach((el) => {
                const file = el.getAttribute("data-b64-src");
                const type = el.getAttribute("data-b64-type");
                fetchAssetBlobURL(resolveAssetUrl(file), type)
                    .then((blobUrl) => {
                        el.src = blobUrl;
                        if (el.tagName === "VIDEO") el.load();
                    })
                    .catch((err) => console.error(`Failed to load ${file}:`, err));
            });

            const slider = popupEl.querySelector(".slider");
            const slides = popupEl.querySelectorAll(".slide");
            const prevBtn = popupEl.querySelector(".slider_buttons .prev");
            const nextBtn = popupEl.querySelector(".slider_buttons .next");

            let currentIndex = 0;
            const goToSlide = (index) => {
                currentIndex = (index + slides.length) % slides.length;
                slider.style.transform = `translateX(-${currentIndex * 100}%)`;
            };

            if (prevBtn) prevBtn.addEventListener("click", () => goToSlide(currentIndex - 1));
            if (nextBtn) nextBtn.addEventListener("click", () => goToSlide(currentIndex + 1));

            goToSlide(0);

            setupRecordPlayer(popupEl, "H4.mp3", "Hotspot_4");
        },
    },
    Hotspot_5: {
        className: "hotspot-content-5",
        render: () => `
    <div class="main_wrapper">
        <h1>Outro.</h1>

        <div class="slider_buttons">
            <button class="mode_selector_button prev" type="button">
                <svg width="100%" height="100%" viewBox="0 0 24 24" fill="none"
                    xmlns="http://www.w3.org/2000/svg">
                    <path d="M15 18L9 12L15 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"
                        stroke-linejoin="round" />
                </svg>
                <span>Prev</span>
            </button>
            <button class="mode_selector_button next" type="button">
                <span>Next</span>
                <svg width="100%" height="100%" viewBox="0 0 24 24" fill="none"
                    xmlns="http://www.w3.org/2000/svg">
                    <path d="M9 18L15 12L9 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"
                        stroke-linejoin="round" />
                </svg>
            </button>
        </div>

        <div class="slider_viewport">
            <div class="slider">
                <div class="slide_1 slide">
                    <img data-b64-src="Hotspot_Head_5.png" data-b64-type="image/png" alt="">
                </div>

                <div class="slide_2 slide">
                    <p>
                        This project represents roughly one-quarter of the larger project I am currently developing, which utilizes similar mechanics and concepts. However, this version is, for the most part, a complete and functional build that demonstrates the core ideas and mechanics of the full project.
                    </p>

                    <br>

                    <button class="Record_player" type="button">
                        <svg width="34" height="34" fill="currentColor" viewBox="0 0 24 24">
                            <path fill-rule="evenodd"
                                d="M8.6 5.2A1 1 0 0 0 7 6v12a1 1 0 0 0 1.6.8l8-6a1 1 0 0 0 0-1.6l-8-6Z"
                                clip-rule="evenodd" />
                        </svg>
                    </button>

                    <br>
                    <br>

                    <hr>
                </div>
            </div>
        </div>
    </div>
    `,
        // Same b64-resolution + slider pattern as Hotspot_1-4. Only
        // slide_1's thumbnail needs resolving (Hotspot_Head_5.png).
        init: (popupEl, context = {}) => {
            popupEl.querySelectorAll("[data-b64-src]").forEach((el) => {
                const file = el.getAttribute("data-b64-src");
                const type = el.getAttribute("data-b64-type");
                fetchAssetBlobURL(resolveAssetUrl(file), type)
                    .then((blobUrl) => {
                        el.src = blobUrl;
                        if (el.tagName === "VIDEO") el.load();
                    })
                    .catch((err) => console.error(`Failed to load ${file}:`, err));
            });

            const slider = popupEl.querySelector(".slider");
            const slides = popupEl.querySelectorAll(".slide");
            const prevBtn = popupEl.querySelector(".slider_buttons .prev");
            const nextBtn = popupEl.querySelector(".slider_buttons .next");

            let currentIndex = 0;
            const goToSlide = (index) => {
                currentIndex = (index + slides.length) % slides.length;
                slider.style.transform = `translateX(-${currentIndex * 100}%)`;
            };

            if (prevBtn) prevBtn.addEventListener("click", () => goToSlide(currentIndex - 1));
            if (nextBtn) nextBtn.addEventListener("click", () => goToSlide(currentIndex + 1));

            goToSlide(0);

            setupRecordPlayer(popupEl, "H5.mp3", "Hotspot_5");
        },
    },
    Hotspot_6: {
        className: "hotspot-content-2",
        render: () => `
    <div class="main_wrapper about">
        <h1>What up.</h1>

        <p>Hey guys, I'm Drei, a Cybersecurity Oriented developer focusing on Web Systems and avid pursuer of DevSecOps practices.</p>
    </div>
    `
    },
    Hotspot_7: {
        className: "hotspot-content-3",
        render: () => `
    <div class="main_wrapper about">
        <h1>What up. (Pt 2)</h1>

        <p>I also do game development as a creative outlet.</p>
    </div>
    `
    },
    Hotspot_8: {
        className: "hotspot-content-4",
        render: () => `
    <div class="main_wrapper about">
        <h1>Let me tell you something...</h1>

        <p>My hobbies include biking, coding, and (most recenetly) going to the gym.</p>
    </div>
    `
    },
    Hotspot_9: {
        className: "hotspot-content-5",
        render: () => `
    <div class="main_wrapper about">
        <h1>A message of Thanks.</h1>

        <p>Thanks for exploring this little project I made. Was fun devloping and I hoped you found it enjoyable.</p>
    </div>
    `
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
        // See the module-level `narrationChangeCallback` declaration above
        // — wired to BackgroundMusicManager.setDucked by main.js.
        narrationChangeCallback = context.onNarrationStateChange || null;
        this.hotspots = []; // { name, position, content, node, hidden }
        this.activeHotspot = null; // currently-inside hotspot, or null
        this.glowMaterials = []; // pulsed each frame, same pattern as GlowPath
        // True while the currently-open popup was opened via
        // triggerHotspot() (the dev-tool "force-trigger" buttons) rather
        // than the ball actually rolling into range. update()'s normal
        // proximity exit check is skipped while this is set — otherwise a
        // forced popup would close itself the very next frame, since the
        // ball is (almost always) nowhere near the hotspot it just forced
        // open.
        this._devForced = false;
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
            if (this.activeHotspot.hidden) {
                // A hide-all (e.g. a mode switch) should still close a
                // forced-open popup — this check runs regardless of
                // _devForced.
                this._exit();
            } else if (!this._devForced) {
                const dist = ballPosition.distanceTo(this.activeHotspot.position);
                if (dist > HOTSPOT_EXIT_RADIUS) {
                    this._exit();
                }
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

    // Dev-tool hook: fires a hotspot's popup by name without requiring the
    // ball to actually be in range. Goes through the same _enter() path as
    // a real trigger (including the onEnter callback/stick timer), so it's
    // a faithful preview of HOTSPOT_CONTENT changes. Sets _devForced so
    // update()'s normal "ball is too far away" exit check doesn't
    // immediately close it again next frame — see closePopup() to dismiss
    // it manually. No-op if the name isn't registered or is currently
    // hidden (e.g. suppressed mid-run).
    triggerHotspot(name) {
        const hotspot = this.hotspots.find((h) => h.name === name && !h.hidden);
        if (!hotspot) return;
        this._devForced = true;
        this._enter(hotspot);
    }

    // Dev-tool hook: closes whichever popup is currently open — forced or
    // a real proximity trigger — and clears the forced-open flag so
    // proximity-based enter/exit resumes normally afterward.
    closePopup() {
        this._exit();
    }

    _enter(hotspot) {
        this.activeHotspot = hotspot;
        currentActiveHotspotName = hotspot.name;
        this.popupEl.innerHTML = hotspot.content.render();
        this.popupEl.className = hotspot.content.className;
        void this.popupEl.offsetWidth;
        this.popupEl.classList.add("visible");

        if (hotspot.content.init) hotspot.content.init(this.popupEl, this.context);

        // Arriving at a hotspot can only ever hide the cancel button (its
        // own clip, if playing, is now controllable via the in-popup
        // button) — never show it, so this is safe to call unconditionally.
        refreshCancelButtonVisibility();

        if (this.onEnter) this.onEnter(hotspot);
    }

    _exit() {
        this.activeHotspot = null;
        this._devForced = false;
        currentActiveHotspotName = null;
        this.popupEl.classList.remove("visible");
        // Note: any Record_player narration is deliberately left playing
        // here — it's meant to keep going while the player roams away from
        // the hotspot that started it. See the `narration` state and
        // refreshCancelButtonVisibility() above; the floating cancel
        // button (not popup teardown) is what lets the player stop it.
        refreshCancelButtonVisibility();
    }

    get isActive() {
        return this.activeHotspot !== null;
    }
}