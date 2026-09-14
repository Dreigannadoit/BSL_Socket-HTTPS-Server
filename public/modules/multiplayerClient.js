// Thin WebSocket wrapper around the 2-Player Rush protocol (see
// server/multiplayerServer.js for the authoritative message list). This
// class owns nothing about Three.js/physics/UI — it just connects, sends,
// and re-dispatches incoming messages as plain callbacks. MultiplayerManager
// (multiplayerManager.js) is what actually reacts to them.
//
// Why a separate Node process at all, not BSL: see the earlier feasibility
// analysis — BSL_Socket's socket_accept() blocks and there's no thread/
// select/fork primitive in BSL, so it can't hold two players' connections
// open at once. This is why "host" here means "the host's browser talks to
// a small Node process running on the host's own machine" rather than BSL
// itself acting as the multiplayer server.
export class MultiplayerClient {
    constructor() {
        this.ws = null;
        this.role = null; // "host" | "guest", set once the server confirms it
        this.handlers = {}; // type -> [callback, ...]
        this._sendQueue = [];
    }

    on(type, cb) {
        (this.handlers[type] ||= []).push(cb);
        return this;
    }

    _emit(type, msg) {
        for (const cb of this.handlers[type] || []) cb(msg);
    }

    // `address` is either a bare host ("192.168.1.42") or "host:port" — if
    // no port is given, DEFAULT_MP_PORT (config.js) is assumed, matching
    // the server's own default.
    connect(address, defaultPort, role) {
        return new Promise((resolve, reject) => {
            let host = address.trim();
            let port = defaultPort;
            if (host.includes(":")) {
                const [h, p] = host.split(":");
                host = h;
                port = Number(p) || defaultPort;
            }
            // "Join Server" always dials out to someone else's machine;
            // "Host Game" talks to the Node process the host is expected
            // to also be running locally — localhost is the right default
            // there specifically because both the browser and the node
            // process are on the same machine.
            const url = `ws://${host}:${port}`;

            let settled = false;
            const ws = new WebSocket(url);
            this.ws = ws;

            const connectTimeout = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    ws.close();
                    reject(new Error("Connection timed out. Is the multiplayer server running on that address?"));
                }
            }, 6000);

            ws.addEventListener("open", () => {
                ws.send(JSON.stringify({ type: "identify", role }));
            });

            ws.addEventListener("message", (event) => {
                let msg;
                try {
                    msg = JSON.parse(event.data);
                } catch {
                    return;
                }

                if (!settled && msg.type === "role_assigned") {
                    settled = true;
                    clearTimeout(connectTimeout);
                    this.role = msg.role;
                    resolve(msg.role);
                }
                if (!settled && msg.type === "identify_error") {
                    settled = true;
                    clearTimeout(connectTimeout);
                    ws.close();
                    reject(new Error(msg.reason || "Could not join that session."));
                }

                this._emit(msg.type, msg);
            });

            ws.addEventListener("error", () => {
                if (!settled) {
                    settled = true;
                    clearTimeout(connectTimeout);
                    reject(new Error("Could not reach a multiplayer server at " + url + "."));
                }
            });

            ws.addEventListener("close", () => {
                this._emit("_socket_closed", {});
            });
        });
    }

    send(type, payload = {}) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        this.ws.send(JSON.stringify({ type, ...payload }));
    }

    disconnect() {
        if (this.ws) {
            try {
                this.send("exit");
            } catch {
                /* socket already going away */
            }
            this.ws.close();
        }
        this.ws = null;
        this.role = null;
    }

    get connected() {
        return !!this.ws && this.ws.readyState === WebSocket.OPEN;
    }
}
