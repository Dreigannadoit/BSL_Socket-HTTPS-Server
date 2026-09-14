@echo off
REM Regenerates the ".b64" sidecar files under public\assets\ using
REM certutil, which ships with Windows -- no Node/npm/Python needed.
REM
REM assets/ is split into one subfolder per media type:
REM   public\assets\audio\   (.mp3)
REM   public\assets\images\  (.png/.jpg/.jpeg)
REM   public\assets\video\   (.mp4)
REM   public\assets\models\  (.glb)
REM This script walks all four with `for /r`, so a new file just needs to be
REM dropped in the matching subfolder -- nothing here needs editing.
REM
REM Run this whenever you add or replace a binary asset (mp3/mp4/glb/png)
REM that gets fetched at runtime by public/modules/*.js. Assets referenced
REM only from static HTML are inlined as data URIs instead and don't need a
REM .b64 file -- see about.html.
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
set ASSETS_DIR=%~dp0\..\public\assets
set EXTS=*.mp3 *.mp4 *.glb *.png *.jpg *.jpeg

for %%D in (audio images video models) do (
    if exist "%ASSETS_DIR%\%%D" (
        for /r "%ASSETS_DIR%\%%D" %%F in (%EXTS%) do (
            echo Encoding %%~nx%%F ...
            certutil -encode "%%F" "%%F.b64" >nul
        )
    ) else (
        echo SKIP: %ASSETS_DIR%\%%D does not exist
    )
)

echo.
echo Done. binaryAssetLoader.js strips certutil's BEGIN/END CERTIFICATE
echo lines automatically, so no further cleanup is needed.
endlocal
