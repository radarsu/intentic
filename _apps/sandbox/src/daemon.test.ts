import { expect, test } from "vitest";
import type { AgentEvent, AgentRequest } from "./agent.js";
import { createDaemon, type DaemonDeps } from "./daemon.js";
import type { DevServer } from "./dev-server.js";
import { workspacePaths } from "./workspace.js";

const fakeDevServer = (status: Awaited<ReturnType<DevServer["status"]>>): DevServer => ({
    start: () => {},
    stop: () => {},
    status: async () => status,
});

const deps = (overrides: Partial<DaemonDeps> = {}): DaemonDeps => ({
    workspace: workspacePaths("/work"),
    devServer: fakeDevServer({ running: true, port: 5173, healthy: true }),
    ...overrides,
});

test("GET /health reports ok", async () => {
    const res = await createDaemon(deps()).request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
});

test("GET /preview returns the dev server status", async () => {
    const res = await createDaemon(deps()).request("/preview");
    expect(await res.json()).toEqual({ running: true, port: 5173, healthy: true });
});

test("GET /self-host reports null by default, and the host descriptor when wired", async () => {
    expect(await (await createDaemon(deps()).request("/self-host")).json()).toEqual({ selfHost: null });

    const wired = createDaemon(deps({ selfHost: { user: "intentic", address: "host.docker.internal", port: 22 } }));
    expect(await (await wired.request("/self-host")).json()).toEqual({
        selfHost: { user: "intentic", address: "host.docker.internal", port: 22 },
    });
});

test("POST /agent streams the agent events as SSE frames", async () => {
    const events: AgentEvent[] = [{ kind: "session", sessionId: "s1" }, { kind: "delta", text: "hi" }, { kind: "done" }];
    const app = createDaemon(
        deps({
            agent: async function* () {
                yield* events;
            },
        }),
    );
    const res = await app.request("/agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "do it" }),
    });
    const body = await res.text();
    for (const event of events) {
        expect(body).toContain(`data: ${JSON.stringify(event)}`);
    }
});

test("POST /agent resolves the oauth token from the sandbox store (not the body) and forwards model/session", async () => {
    let seen: AgentRequest | undefined;
    const app = createDaemon(
        deps({
            claudeStore: { read: async () => ({ accessToken: "tok-xyz" }), write: async () => {}, clear: async () => {} },
            agent: async function* (request) {
                seen = request;
                yield { kind: "done" } as AgentEvent;
            },
        }),
    );
    await app.request("/agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "do it", sessionId: "s1", model: "opus" }),
    });
    expect(seen?.oauthToken).toBe("tok-xyz");
    expect(seen?.model).toBe("opus");
    expect(seen?.sessionId).toBe("s1");
});

test("POST /agent omits the oauth token when no account is connected (SDK falls back to container env)", async () => {
    let seen: AgentRequest | undefined;
    const app = createDaemon(
        deps({
            claudeStore: { read: async () => undefined, write: async () => {}, clear: async () => {} },
            agent: async function* (request) {
                seen = request;
                yield { kind: "done" } as AgentEvent;
            },
        }),
    );
    await app.request("/agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "do it" }),
    });
    expect(seen?.oauthToken).toBeUndefined();
});

test("Claude OAuth: exchange stores the account, status reports it, disconnect clears it", async () => {
    const writes: unknown[] = [];
    let stored: { accessToken: string; scope?: string } | undefined;
    const app = createDaemon(
        deps({
            claudeStore: {
                read: async () => stored,
                write: async (account) => {
                    writes.push(account);
                    stored = account;
                },
                clear: async () => {
                    stored = undefined;
                },
            },
        }),
    );
    const before = await (await app.request("/claude/account")).json();
    expect(before).toEqual({ connected: false });

    // The start route hands the browser an authorize URL + PKCE material.
    const challenge = await (await app.request("/claude/oauth/start", { method: "POST" })).json();
    expect(typeof challenge.authorizeUrl).toBe("string");
    expect(typeof challenge.verifier).toBe("string");

    // Directly store (exchange itself hits Anthropic; the store wiring is what we assert here).
    stored = { accessToken: "tok", scope: "user:inference" };
    const after = await (await app.request("/claude/account")).json();
    expect(after).toEqual({ connected: true, scope: "user:inference" });

    const disconnect = await app.request("/claude/account/disconnect", { method: "POST" });
    expect(disconnect.status).toBe(200);
    expect(stored).toBeUndefined();
});

test("POST /agent rejects an empty prompt", async () => {
    const res = await createDaemon(deps()).request("/agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "" }),
    });
    expect(res.status).toBe(400);
});

test("GET /git/:repo/status resolves the repo dir, and rejects an unknown repo", async () => {
    const seen: string[] = [];
    const app = createDaemon(
        deps({
            git: {
                status: async (dir) => {
                    seen.push(dir);
                    return { branch: "main", dirty: false, files: [] };
                },
                listFiles: async () => [],
                commitAll: async () => false,
                push: async () => {},
            },
        }),
    );
    expect((await app.request("/git/app/status")).status).toBe(200);
    expect(seen).toEqual(["/work/app"]);
    expect((await app.request("/git/nope/status")).status).toBe(404);
});

test("GET /git/:repo/files lists the repo's tracked files", async () => {
    const app = createDaemon(
        deps({
            git: {
                status: async () => ({ branch: "main", dirty: false, files: [] }),
                listFiles: async (dir) => (dir === "/work/intent" ? ["deploy.config.ts", "package.json"] : []),
                commitAll: async () => false,
                push: async () => {},
            },
        }),
    );
    expect(await (await app.request("/git/intent/files")).json()).toEqual({ files: ["deploy.config.ts", "package.json"] });
});

test("GET /git/:repo/file reads a contained file, 404s a missing one, and 400s a path escape", async () => {
    const app = createDaemon(
        deps({
            files: {
                read: async (absPath) => (absPath === "/work/intent/deploy.config.ts" ? "export const intent = 1;" : undefined),
                write: async () => {},
            },
        }),
    );
    const ok = await app.request("/git/intent/file?path=deploy.config.ts");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ path: "deploy.config.ts", content: "export const intent = 1;" });
    expect((await app.request("/git/intent/file?path=nope.ts")).status).toBe(404);
    expect((await app.request("/git/intent/file?path=../../etc/passwd")).status).toBe(400);
});

test("PUT /git/:repo/file writes a contained file and rejects a path escape", async () => {
    const writes: { path: string; content: string }[] = [];
    const app = createDaemon(
        deps({
            files: {
                read: async () => undefined,
                write: async (absPath, content) => {
                    writes.push({ path: absPath, content });
                },
            },
        }),
    );
    const ok = await app.request("/git/intent/file", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "deploy.config.ts", content: "next" }),
    });
    expect(ok.status).toBe(200);
    expect(writes).toEqual([{ path: "/work/intent/deploy.config.ts", content: "next" }]);

    const escape = await app.request("/git/intent/file", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "../escape", content: "x" }),
    });
    expect(escape.status).toBe(400);
    expect(writes).toHaveLength(1);
});
