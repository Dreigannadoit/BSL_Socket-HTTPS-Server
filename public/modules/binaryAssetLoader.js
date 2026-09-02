// Fetches a base64-encoded sidecar file (e.g. "engine.mp3.b64", produced by
// scripts/encode-assets.bat) and decodes it back to raw bytes in the
// browser.
//
// Why this exists: the BSL server's readFile()/socket_write() treat every
// file as a null-terminated string, so any binary asset containing a 0x00
// byte gets silently truncated in transit (confirmed via
// src/diagnose-binary.bzg — a 12,935-byte mp3 came back as 4 bytes). Base64
// text has no embedded null bytes, so it survives that pipeline intact —
// this module just undoes the encoding once it reaches the browser.

// certutil -encode (Windows) wraps its output in
// "-----BEGIN CERTIFICATE-----" / "-----END CERTIFICATE-----" lines; the
// base64 CLI (Linux/Mac, used to pre-generate the .b64 files that ship in
// this repo) doesn't. Filtering out any "-----" line makes this work with
// either encoder, so re-running scripts/encode-assets.bat on Windows later
// (e.g. after swapping in a new asset) doesn't require touching this file.
function stripEnvelope(text) {
    return text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("-----"))
        .join("");
}

function base64ToArrayBuffer(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
}

// Fetches "<url>.b64", decodes it, and returns the raw bytes as an
// ArrayBuffer — use this for anything that wants bytes directly
// (AudioContext.decodeAudioData, GLTFLoader.parse).
export async function fetchBinaryAsset(url) {
    const res = await fetch(url + ".b64");
    if (!res.ok) {
        throw new Error(`Failed to fetch ${url}.b64: ${res.status} ${res.statusText}`);
    }
    const text = await res.text();
    return base64ToArrayBuffer(stripEnvelope(text));
}

// Same fetch/decode, but wraps the bytes in a Blob and returns an object
// URL — use this for anything that wants a src URL (<img>, <video>).
// Revoke the returned URL with URL.revokeObjectURL() once it's no longer
// needed, if it's created repeatedly (e.g. every time a hotspot popup
// opens) rather than once at startup.
export async function fetchAssetBlobURL(url, mimeType) {
    const buffer = await fetchBinaryAsset(url);
    const blob = new Blob([buffer], { type: mimeType });
    return URL.createObjectURL(blob);
}
