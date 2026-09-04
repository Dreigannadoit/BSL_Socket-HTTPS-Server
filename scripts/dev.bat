@echo off
REM Starts both dev-time processes:
REM   1. The BSL socket server (src/http.bzg), in its own window, so its
REM      "Client connected!" logs don't interleave with the watcher's.
REM   2. scripts/dev-watch.js, in THIS window -- the asset/.b64 sync and
REM      live-reload watcher described at the top of that file.
REM
REM Close this window (or Ctrl+C) to stop the watcher; close the other
REM window to stop the BSL server. They're independent processes.

cd /d "%~dp0\.."

start "BSL Server (src/http.bzg)" cmd /k bonezegei src/http.bzg
node scripts\dev-watch.js
