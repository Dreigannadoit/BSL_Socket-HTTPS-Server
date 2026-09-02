@echo off
REM Regenerates the ".b64" sidecar files under public\assets\ using
REM certutil, which ships with Windows -- no Node/npm/Python needed.
REM
REM Run this whenever you add or replace a binary asset (mp3/mp4/glb/png)
REM that gets fetched at runtime by public/modules/*.js. Assets referenced
REM only from static HTML (like about.html's Hotspot_2.png) are inlined
REM as data URIs instead and don't need a .b64 file -- see about.html.
REM
REM Usage:
REM   scripts\encode-assets.bat
REM
REM Why this exists: BSL's readFile()/socket_write() treat files as
REM null-terminated strings and silently truncate any binary content at
REM its first 0x00 byte (confirmed via src\diagnose-binary.bzg). Base64
REM text has no embedded nulls, so it survives that pipeline intact --
REM public/modules/binaryAssetLoader.js fetches and decodes it back to
REM bytes in the browser.

setlocal enabledelayedexpansion
cd /d "%~dp0\..\public\assets"

set FILES=bounce1.mp3 bounce2.mp3 bounce3.mp3 bounce4.mp3 bounce5.mp3 engine.mp3 hotspot.mp3 rolling.mp3 ball.glb maze_platform_high.glb FreeRoam.png Speedrun.mp4 TimeTrial.mp4

for %%F in (%FILES%) do (
    if exist "%%F" (
        echo Encoding %%F ...
        certutil -encode "%%F" "%%F.b64" >nul
    ) else (
        echo SKIP: %%F not found in public\assets\
    )
)

echo.
echo Done. binaryAssetLoader.js strips certutil's BEGIN/END CERTIFICATE
echo lines automatically, so no further cleanup is needed.
endlocal
