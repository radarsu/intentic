import { existsSync } from "node:fs";
import { upgradeWebSocket } from "@hono/node-server";
import { type IPty, spawn } from "node-pty";
import type { Services } from "../composition.js";
import { resolveWithin } from "../workspace/workspace-files.js";

// One interactive PTY the browser drives over a WebSocket — the sandbox's "open a terminal in here" surface, so
// the owner can watch processes, re-run a failed dev command and see WHY it failed, and generally poke around.
// The container runs as root and IS the isolation boundary (the agent already has an autonomous root shell), so
// a shell for the authenticated owner adds no new trust surface.

// The wire protocol, JSON both ways (xterm speaks strings). Kept tiny and defined on each side (the web app
// doesn't import this contract package — it re-declares the agent event shapes too).
type ClientMessage = { readonly type: "input"; readonly data: string } | { readonly type: "resize"; readonly cols: number; readonly rows: number };

// Spawn a shell rooted in the workspace. `cwd` is a workspace-relative path from the terminal's ?cwd= query; it
// must resolve inside /work (resolveWithin returns undefined on escape) and exist, else we fall back to the root.
const spawnShell = (root: string, cwd: string | undefined, cols: number, rows: number): IPty => {
    const requested = cwd !== undefined && cwd !== "" ? resolveWithin(root, cwd) : undefined;
    const dir = requested !== undefined && existsSync(requested) ? requested : root;
    return spawn("zsh", [], { name: "xterm-color", cwd: dir, env: process.env, cols, rows });
};

const dimension = (value: string | undefined, fallback: number): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

// The /system/terminal route. node-server's upgradeWebSocket runs after the Hono auth middleware, which the
// browser's header-less WebSocket can't satisfy — so app.ts exempts this path and we authorize the token +
// connect token from the query string here instead (short-lived Google JWT over wss/TLS via the tunnel).
export const createTerminalRoute = (services: Services) =>
    upgradeWebSocket((c) => {
        let pty: IPty | undefined;
        return {
            onOpen: async (_event, ws) => {
                const url = new URL(c.req.url);
                if (services.auth !== undefined) {
                    try {
                        await services.auth.authorize(url.searchParams.get("token") ?? "", url.searchParams.get("connect") ?? undefined);
                    } catch {
                        ws.close(1008, "unauthorized");
                        return;
                    }
                }
                const cols = dimension(url.searchParams.get("cols") ?? undefined, 80);
                const rows = dimension(url.searchParams.get("rows") ?? undefined, 24);
                pty = spawnShell(services.workspace.root, url.searchParams.get("cwd") ?? undefined, cols, rows);
                pty.onData((data) => ws.send(JSON.stringify({ type: "data", data })));
                pty.onExit(({ exitCode }) => {
                    ws.send(JSON.stringify({ type: "exit", code: exitCode }));
                    ws.close();
                });
            },
            onMessage: (event) => {
                if (pty === undefined) {
                    return;
                }
                let message: ClientMessage;
                try {
                    message = JSON.parse(String(event.data)) as ClientMessage;
                } catch {
                    return;
                }
                if (message.type === "input") {
                    pty.write(message.data);
                } else if (message.type === "resize") {
                    pty.resize(dimension(String(message.cols), 80), dimension(String(message.rows), 24));
                }
            },
            onClose: () => pty?.kill(),
            onError: () => pty?.kill(),
        };
    });
