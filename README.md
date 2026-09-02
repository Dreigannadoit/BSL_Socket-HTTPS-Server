# Maze Ball — BSL Socket HTTP Server

## 1. Project Description

**Maze Ball** is a small 3D browser game (built with Three.js and the cannon-es
physics engine) paired with a lightweight custom HTTP server written from
scratch in the **Bonezegei Scripting Language (BSL)**.

Instead of relying on a framework like Express or Node's built-in `http`
module, the server (`src/http.bzg`) talks to raw TCP sockets through BSL's
`socket` native library and manually parses HTTP requests, builds HTTP
responses, and serves everything from disk. It exists to demonstrate how a
basic HTTP/1.1 static file server can be implemented at the socket level.

Everything now runs through a single process:

| Component | Role | Port |
|---|---|---|
| **BSL socket server** (`src/http.bzg`) | Hand-rolled HTTP server that routes `/`, `/home`, `/about`, a 404 page, and every static file under `public/` (JS modules, CSS, `.glb` models, `.mp3`/`.mp4` assets) by extension-based Content-Type | `3000` |

There is no separate Node/Python asset server anymore. The ~783 KB failure
mentioned below turned out to be a real, confirmed bug rather than a fluke:
BSL's `readFile()`/`socket_write()` treat every file as a null-terminated
string, so any binary asset with an embedded `0x00` byte gets silently
truncated in transit (see `src/diagnose-binary.bzg` — a 12,935-byte `.mp3`
came back as 4 bytes) regardless of file size.

The fix: every binary asset (`.mp3`/`.mp4`/`.glb`/`.png`) fetched at runtime
ships as a base64-encoded `<name>.ext.b64` sidecar file alongside the
original — pure ASCII text, no embedded nulls, so it passes through
`readFile()`/`socket_write()` intact no matter how large the underlying
file is. The client fetches the `.b64` file and decodes it back to bytes —
see `public/modules/binaryAssetLoader.js`. `about.html`'s one static image
(`Hotspot_2.png`) is inlined directly as a base64 `data:` URI instead, since
there's no JS on that page to decode a sidecar file.

If you add or swap a binary asset, regenerate its `.b64` file with
`scripts\encode-assets.bat` (uses Windows' built-in `certutil`, no Node
required).

`Speedrun.mp4` and `TimeTrial.mp4` were also re-encoded down from
1080p60/26–71 MB to 640px/24fps/~0.7–1.7 MB (they're muted background loops
in a small UI card, so the original resolution/bitrate was serving no
purpose) — base64 adds ~33% on top of whatever the source file is, and that
was worth avoiding at the original sizes. Swap in higher-quality masters
and re-run the encode script if you want the fidelity back, but keep an eye
on the resulting `.b64` size — it's still going through a single-threaded,
one-shot `socket_write()` per request.

**The `.b64` files are the actual source of truth at runtime, not the
originals.** Nothing in `public/modules/*.js` reads the raw `.mp3`/`.glb`/
`.mp4`/`.png` files anymore — only their `.b64` sidecars. If you replace an
asset, re-run `npm run encode-assets` (or `scripts\encode-assets.bat`
directly) afterward, or the game keeps loading the old one. If a `.b64`
file goes missing, that specific asset fails loudly in the browser console
(`Failed to fetch .../foo.mp3.b64: 404`) rather than silently truncating.

The `/home` page loads `game.js` and renders the Maze Ball game itself: a
ball you roll through a 3D maze platform using WASD or the arrow keys.

## 2. Installation & Setup Guide

### Prerequisites

- **BSL (Bonezegei Scripting Language)** interpreter: Used to run the
  socket server.
- Windows is required for this specific build, because the bundled socket
  library (`lib/socket/socket.dll`) is a compiled Windows DLL.
- Node.js/npm are optional now — `package.json` wraps two things behind
  `npm run dev`: regenerating the `.b64` asset sidecars (`certutil`, no
  Node needed for the encoding itself) and then starting `bonezegei
  src/http.bzg`. You can run the interpreter directly instead; see Step 3
  below.

### Step 1: Install the BSL interpreter

Pick whichever method matches your setup:

**Option A - Microsoft Store (recommended for Windows 10/11)**
1. Open the **Microsoft Store** app.
2. Search for **"Bonezegei Scripting Language"**.
3. Click **Get** / **Install** and wait for it to finish.

**Option B - Standalone Windows installer (.msi)**
1. Download the latest **Windows x64 .msi** from the official BSL GitHub
   releases page.
2. Double-click the `.msi` to launch the setup wizard.
3. If SmartScreen flags it as an "Unknown Publisher" (the installer is
   self-signed), click **More info → Run anyway**.
4. Follow the wizard, accept the MIT License, and click **Finish**.

**Verify the install** by opening a terminal and running:

```bash
bonezegei --version
```

You should see the installed BSL version printed.

### Step 2: Set up the socket library

The socket library this project uses is **already bundled in the
repository** — you don't need to download it separately:

- `lib/socket.bzg` — BSL wrapper that loads the native functions
  (`socket_init`, `socket_create`, `socket_bind`, `socket_listen`,
  `socket_accept`, `socket_read`, `socket_write`, `socket_close`,
  `socket_cleanup`, `socket_connect`).
- `lib/socket/socket.dll` — the compiled native library those functions are
  loaded from via `loadNative(...)`.

As long as the `lib/` folder stays next to `src/http.bzg`, BSL will resolve
the `include("lib/socket.bzg")` call at the top of the server script
automatically. No       extra install step is required.

**NOTE:** To redownload socket, delete the `lib` folder and run in terminal the command.

```bash
bzg install socket
```

### Step 3: Run the server

From the project root, either run the interpreter directly:

```bash
bonezegei src/http.bzg
```

or, if you have Node/npm available:

```bash
npm run dev
```

`npm run dev` first re-runs `scripts\encode-assets.bat` (regenerating every
`.b64` sidecar under `public/assets/` from the current binary files, via
Windows' built-in `certutil` — no Node involved in the encoding itself),
*then* starts `bonezegei src/http.bzg`. It's sequential on purpose: the
encode step is a quick one-shot batch, not a long-running process, so
running it concurrently with the server risked the server accepting
requests before a `.b64` file (especially the larger `TimeTrial.mp4.b64`)
finished being rewritten.

Two narrower scripts if you don't need the full `dev` flow:

| Script | What it does |
|---|---|
| `npm run encode-assets` | Just re-runs `scripts\encode-assets.bat` — regenerate the `.b64` files without starting the server |
| `npm run dev:skip-encode` | Skips straight to `bonezegei src/http.bzg` — use when you know the `.b64` files are already current |

Either way, there's only one long-running process, on port `3000` — `npm
run dev` and `bonezegei src/http.bzg` are equivalent once the encode step
is done.

A successful start prints `Server running on http://localhost:3000/` in
the terminal.

###### Developer's Note: When I was developing and implementing the 3D objects for Three.js to use, the program kept failing. At the time I was using pure BSL to load. The problem was BSL wouldn't load in my world because the file size was too large (~783 KB). So I used a separate server (first Python, then `npx serve`) to load the 3D assets instead.
###### Update: `src/http.bzg` now serves the whole `public/` folder itself (see the MIME-type table and static-asset routing near the top of the file), so that separate server is gone. The ~783 KB failure wasn't actually a file-size ceiling — it was `readFile()`/`socket_write()` truncating binary data at the first embedded `0x00` byte, confirmed with `src/diagnose-binary.bzg`. Fixed by shipping every binary asset as a base64 `.b64` sidecar (pure text, no embedded nulls) and decoding it back to bytes in the browser — see `public/modules/binaryAssetLoader.js` and `scripts/encode-assets.bat`. The two `.mp4`s were also re-encoded way down (1080p60 → 640px/24fps) since base64 adds ~33% on top and the originals were 26–71 MB for a muted background loop.

## 3. Usage Instructions

With the server running, open a browser and try the following endpoints:

| URL | What it does |
|---|---|
| `http://localhost:3000/` | Redirects (`302 Found`) to `/home` |
| `http://localhost:3000/home` | Loads the Maze Ball game (`public/index.html`), which pulls `game.js`, its modules, and the 3D assets — all from this same server now |
| `http://localhost:3000/about` | Loads the about page (`public/about.html`) |
| `http://localhost:3000/style.css`, `/game.js` | Served directly from `public/` with the right `Content-Type` |
| `http://localhost:3000/modules/*` | Any file under `public/modules/` (e.g. `/modules/sky.js`) |
| `http://localhost:3000/assets/*` | Any file under `public/assets/` (models, audio, images, video) |
| `http://localhost:3000/anything-else` | Any unrecognized path returns a `404 Not Found` with `public/404.html` |

Once `/home` loads, use **WASD** or the **arrow keys** to roll the ball
through the maze. The heads-up display in the top-left corner confirms the
controls and shows load status.

Each request is logged to the BSL server's terminal (e.g. `File Requested:
/home`, `Client connected!`), which is useful for confirming the socket
server is receiving and routing requests correctly.