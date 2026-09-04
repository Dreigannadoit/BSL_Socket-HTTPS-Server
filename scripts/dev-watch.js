// scripts/dev-watch.js
//
// Dev-only companion process. Run this ALONGSIDE `bonezegei src/http.bzg`
// (it does not replace it, and never touches port 3000). It does two
// things for the length of the dev session:
//
//   1. Asset watcher — keeps every binary asset's ".b64" sidecar in sync
//      automatically:
//        - new or changed file in public/assets/  -> (re)encode it
//        - a source file gets deleted             -> delete its .b64 too
//      This replaces manually re-running scripts/encode-assets.bat.
//
//   2. Live-reload watcher — watches public/ for .html/.css/.js changes
//      (including public/modules/) and pushes a "reload" event to the
//      browser over Server-Sent Events, so the page refreshes itself the
//      moment you save a file. See public/modules/liveReload.js for the
//      tiny client that listens for this.
//
// Why Node and not BSL: BSL has no documented file-watching, timer, or
// background-thread primitive to build this on top of (see
// src/experiment-http.bzg / src/diagnose-binary.bzg for the kind of
// undocumented-behavior digging that would be required to even find out).
// The BSL server already re-reads every file from disk on each request —
// it never needed restarting for html/js/css edits, only the browser
// needed telling. Node fills that one gap; it stays a dev-time-only
// process, nothing about the production request path changes.
//
// Usage:  node scripts/dev-watch.js   (wired up as `npm run dev`)

const fs = require("fs");
const path = require("path");
const http = require("http");

const ROOT = path.join(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const ASSETS_DIR = path.join(PUBLIC_DIR, "assets");
const LIVERELOAD_PORT = 3001;

// ── asset encoding ──────────────────────────────────────────────────────

// Extensions that ship as ".b64" sidecars (mirrors scripts/encode-assets.bat
// and public/modules/binaryAssetLoader.js). .svg is deliberately excluded —
// it's plain text and public/assets/IconMe.svg is served as-is.
const BINARY_EXTS = new Set([".png", ".jpg", ".jpeg", ".mp3", ".mp4", ".glb"]);

function isBinaryAsset(filename) {
    return BINARY_EXTS.has(path.extname(filename).toLowerCase());
}

function encodeAsset(filePath) {
    try {
        const data = fs.readFileSync(filePath);
        fs.writeFileSync(filePath + ".b64", data.toString("base64"));
        console.log(`[assets] encoded ${path.relative(ROOT, filePath)}`);
    } catch (err) {
        // The file can vanish between the fs.watch event firing and this
        // read (editors often write via a temp file + rename, or the user
        // is mid-delete). Treat that as "nothing to encode yet/anymore"
        // rather than an error — the next event will settle it.
        if (err.code !== "ENOENT") {
            console.error(`[assets] failed to encode ${filePath}:`, err.message);
        }
    }
}

function deleteSidecar(filePath) {
    const sidecar = filePath + ".b64";
    fs.unlink(sidecar, (err) => {
        if (!err) console.log(`[assets] removed ${path.relative(ROOT, sidecar)}`);
    });
}

// Editors/OSes frequently fire several fs events for a single save; collapse
// bursts for the same path into one action.
const debounceTimers = new Map();
function debounce(key, fn, delay = 150) {
    clearTimeout(debounceTimers.get(key));
    debounceTimers.set(
        key,
        setTimeout(() => {
            debounceTimers.delete(key);
            fn();
        }, delay)
    );
}

function reconcileAssetsOnStartup() {
    const entries = fs.readdirSync(ASSETS_DIR);
    const sourceNames = new Set(entries.filter((n) => !n.endsWith(".b64")));

    // Encode anything missing or stale (source newer than its .b64).
    for (const name of entries) {
        if (!isBinaryAsset(name)) continue;
        const full = path.join(ASSETS_DIR, name);
        const sidecar = full + ".b64";
        if (!fs.existsSync(sidecar)) {
            encodeAsset(full);
        } else {
            const srcMtime = fs.statSync(full).mtimeMs;
            const b64Mtime = fs.statSync(sidecar).mtimeMs;
            if (srcMtime > b64Mtime) encodeAsset(full);
        }
    }

    // Remove orphaned .b64 files left over from a source file that was
    // deleted while this watcher wasn't running.
    for (const name of entries) {
        if (!name.endsWith(".b64")) continue;
        const sourceName = name.slice(0, -4); // strip ".b64"
        if (!sourceNames.has(sourceName)) {
            fs.unlink(path.join(ASSETS_DIR, name), (err) => {
                if (!err) console.log(`[assets] removed orphaned ${name}`);
            });
        }
    }
}

function watchAssets() {
    if (!fs.existsSync(ASSETS_DIR)) {
        console.warn(`[assets] ${ASSETS_DIR} does not exist, skipping asset watcher`);
        return;
    }

    reconcileAssetsOnStartup();

    fs.watch(ASSETS_DIR, (eventType, filename) => {
        if (!filename || !isBinaryAsset(filename)) return;
        const full = path.join(ASSETS_DIR, filename);
        debounce(full, () => {
            if (fs.existsSync(full)) {
                encodeAsset(full);
            } else {
                deleteSidecar(full);
            }
        });
    });

    console.log(`[assets] watching ${path.relative(ROOT, ASSETS_DIR)} for changes`);
}

// ── live reload (Server-Sent Events) ────────────────────────────────────

const RELOAD_EXTS = new Set([".html", ".css", ".js"]);
const sseClients = [];

function broadcastReload(reason) {
    console.log(`[livereload] ${reason} — reloading ${sseClients.length} client(s)`);
    for (const res of sseClients) res.write("event: reload\ndata: reload\n\n");
}

function watchLiveReload() {
    // recursive:true is supported on Windows and macOS (this project is
    // Windows-only per the README, so that's the target platform); it is
    // not reliable on Linux.
    fs.watch(PUBLIC_DIR, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        // filename may use either slash style depending on OS.
        const normalized = filename.replace(/\\/g, "/");
        if (normalized.startsWith("assets/")) return; // asset watcher's job
        if (!RELOAD_EXTS.has(path.extname(normalized).toLowerCase())) return;
        debounce("livereload", () => broadcastReload(normalized), 100);
    });

    const server = http.createServer((req, res) => {
        if (req.url !== "/events") {
            res.writeHead(404);
            res.end();
            return;
        }
        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            // The page is served from the BSL server on :3000; this SSE
            // endpoint is a different origin (:3001), so it needs CORS.
            "Access-Control-Allow-Origin": "*",
        });
        res.write("\n");
        sseClients.push(res);
        req.on("close", () => {
            const i = sseClients.indexOf(res);
            if (i !== -1) sseClients.splice(i, 1);
        });
    });

    server.listen(LIVERELOAD_PORT, () => {
        console.log(`[livereload] listening on http://localhost:${LIVERELOAD_PORT}/events`);
    });
}

watchAssets();
watchLiveReload();
console.log("Dev watcher running — leave this alongside `bonezegei src/http.bzg`. Ctrl+C to stop.");
