// Dev-only: connects to scripts/dev-watch.js's Server-Sent Events endpoint
// and reloads the page whenever it reports a saved change to an
// html/css/js file under public/. If the watcher isn't running (e.g. you
// only started `bonezegei src/http.bzg` and skipped `npm run dev`), the
// connection just fails and EventSource quietly keeps retrying in the
// background — nothing else on the page is affected.
const source = new EventSource("http://localhost:3001/events");

source.addEventListener("open", () => {
    console.log("[liveReload] connected to dev watcher on :3001");
});

source.addEventListener("reload", () => {
    console.log("[liveReload] change detected, reloading page…");
    location.reload();
});

source.addEventListener("error", () => {
    // EventSource auto-retries on its own; this just makes the "not
    // connected yet" state visible instead of failing silently.
    console.warn(
        "[liveReload] not connected to ws://localhost:3001 — is `npm run dev-watch` " +
        "(or `npm run dev`) running? Retrying…"
    );
});
