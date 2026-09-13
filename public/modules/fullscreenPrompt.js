// Shows a "you're not in fullscreen" popup a few seconds after the page
// loads, prompting the user to enter fullscreen for a better experience.
// Used on both index.html and about.html — plain DOM + inline styles via
// CSS classes in style.css (#fullscreen-prompt), no imports needed, same
// self-contained pattern as liveReload.js.

// How long to wait after load before checking fullscreen state and (if
// needed) showing the popup.
const PROMPT_DELAY_MS = 3000;

// Once the user picks either button, don't ask again for the rest of this
// tab's session (a fresh visit/reload elsewhere still asks). Avoids nagging
// on every page (index -> about -> index) or every dev-watch auto-reload.
const DISMISSED_KEY = "fullscreenPromptDismissed";

function isFullscreen() {
    return !!(
        document.fullscreenElement ||
        document.webkitFullscreenElement || // Safari
        document.msFullscreenElement // old Edge/IE
    );
}

function requestFullscreen() {
    const el = document.documentElement;
    const request =
        el.requestFullscreen ||
        el.webkitRequestFullscreen || // Safari
        el.msRequestFullscreen; // old Edge/IE

    if (!request) {
        console.warn("[fullscreenPrompt] Fullscreen API not available in this browser");
        return;
    }

    request.call(el).catch((err) => {
        // Most commonly a permissions/user-gesture rejection — nothing to
        // recover from, just leave the page windowed.
        console.warn("[fullscreenPrompt] request to enter fullscreen was rejected:", err);
    });
}

function buildPopup() {
    const popup = document.createElement("div");
    popup.id = "fullscreen-prompt";
    popup.innerHTML = `
        <div class="fullscreen-prompt-card">
            <p>Enter fullscreen mode for a better experience</p>
            <div class="fullscreen-prompt-buttons">
                <button type="button" class="fullscreen-prompt-accept">Enter Fullscreen Mode</button>
                <button type="button" class="fullscreen-prompt-decline">I'm okay as Is</button>
            </div>
        </div>
    `;
    document.body.appendChild(popup);
    return popup;
}

function hidePopup(popup) {
    popup.classList.remove("visible");
    // Match the CSS transition duration below before detaching, so the
    // fade-out actually gets to play instead of being cut off.
    setTimeout(() => popup.remove(), 400);
}

function showPopup() {
    const popup = buildPopup();

    // Two rAFs (rather than one) reliably lands after the initial layout
    // on every engine tested — a single frame occasionally coincides with
    // the class add and skips the transition, same trick used elsewhere
    // for popup fade-ins (see hotspotSystem.js).
    requestAnimationFrame(() => requestAnimationFrame(() => popup.classList.add("visible")));

    popup.querySelector(".fullscreen-prompt-accept").addEventListener("click", () => {
        requestFullscreen();
        sessionStorage.setItem(DISMISSED_KEY, "1");
        hidePopup(popup);
    });

    popup.querySelector(".fullscreen-prompt-decline").addEventListener("click", () => {
        sessionStorage.setItem(DISMISSED_KEY, "1");
        hidePopup(popup);
    });

    // If the user enters fullscreen some other way while the popup is up
    // (browser shortcut, etc.), there's no need to keep asking.
    const onFullscreenChange = () => {
        if (isFullscreen() && document.body.contains(popup)) {
            sessionStorage.setItem(DISMISSED_KEY, "1");
            hidePopup(popup);
        }
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    document.addEventListener("webkitfullscreenchange", onFullscreenChange);
    document.addEventListener("msfullscreenchange", onFullscreenChange);
}

if (sessionStorage.getItem(DISMISSED_KEY) !== "1") {
    setTimeout(() => {
        if (!isFullscreen() && sessionStorage.getItem(DISMISSED_KEY) !== "1") {
            showPopup();
        }
    }, PROMPT_DELAY_MS);
}
