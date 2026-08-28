# Maze Ball — BSL Socket HTTP Server

## 1. Project Description

**Maze Ball** is a small 3D browser game (built with Three.js and the cannon-es
physics engine) paired with a lightweight custom HTTP server written from
scratch in the **Bonezegei Scripting Language (BSL)**.

Instead of relying on a framework like Express or Node's built-in `http`
module, the backend (`src/http.bzg`) talks to raw TCP sockets through BSL's
`socket` native library and manually parses HTTP requests, builds HTTP
responses, and serves HTML pages from disk. It exists to demonstrate how a
basic HTTP/1.1 server can be implemented at the socket level.

The project has two moving parts that run side by side:

| Component | Role | Port |
|---|---|---|
| **BSL socket server** (`src/http.bzg`) | Hand-rolled HTTP server that routes `/`, `/home`, `/about`, and serves a 404 page | `3000` |
| **Static asset server** (`npx serve`) | Serves the game's JS bundle and binary assets (`.glb` models, `.mp3` sounds) with CORS enabled, since the BSL server only serves HTML | `8081` |

The `/home` page loads `game.js` from the asset server and renders the Maze
Ball game itself: a ball you roll through a 3D maze platform using WASD or
the arrow keys.

## 2. Installation & Setup Guide

### Prerequisites

- **Node.js** (v16+) and **npm**: Used to run the static asset server and
  the `concurrently` dev script.
- **BSL (Bonezegei Scripting Language)** interpreter: Used to run the
  socket server.
- Windows is required for this specific build, because the bundled socket
  library (`lib/socket/socket.dll`) is a compiled Windows DLL.

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

### Step 3: Install Node dependencies

From the project root:

```bash
npm install
```

This installs `concurrently`, which is used to run both servers with a
single command.

### Step 4: Run the server

```bash
npm run dev
```

This runs two processes at once:

- `npm run bsl` → `bonezegei src/http.bzg` (the game/page server on port
  `3000`)
- `npm run assets` → `npx serve public -l 8081 --cors` (the static asset
  server on port `8081`, serving `game.js` and the `public/assets/` files)


You can also run either process on its own if you only need one:

```bash
npm run bsl       # just the BSL HTTP server
npm run assets     # just the static asset server
```

A successful start prints `Server running on http://localhost:3000/` in
the terminal running the BSL process.


###### Developer's Note: When I was developing and imlementing the 3D obects for Three.js to use, the program kept failing. At the time I was using pure BSL to load. The problem was BSL wouldn't load in my world because the file sie was too large (~783 KB). So I used a seperate python server to load in the 3D asset instead. 

## 3. Usage Instructions

With both servers running, open a browser and try the following endpoints:

| URL | What it does |
|---|---|
| `http://localhost:3000/` | Redirects (`302 Found`) to `/home` |
| `http://localhost:3000/home` | Loads the Maze Ball game (`public/index.html`), which in turn pulls `game.js` and the 3D assets from `http://localhost:8081` |
| `http://localhost:3000/about` | Loads the about page (`public/about.html`) |
| `http://localhost:3000/anything-else` | Any unrecognized path returns a `404 Not Found` with `public/404.html` |

Once `/home` loads, use **WASD** or the **arrow keys** to roll the ball
through the maze. The heads-up display in the top-left corner confirms the
controls and shows load status.

Each request is logged to the BSL server's terminal (e.g. `File Requested:
/home`, `Client connected!`), which is useful for confirming the socket
server is receiving and routing requests correctly.