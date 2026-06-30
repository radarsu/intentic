import { expect, test } from "vitest";
import type { AgentEvent, AgentRequest } from "./agent.js";
import { createDaemon, type DaemonDeps } from "./daemon.js";
import type { DevServer } from "./dev-server.js";
import type { AgentTool } from "./tools.js";
import type { ToolsStore } from "./tools-store.js";
import { workspacePaths } from "./workspace.js";
import { MAX_RAW_BYTES } from "./workspace-files.js";

// An in-memory external-tools store so the daemon's tool routes + turn merge are testable without the fs.
const memoryToolsStore = (initial: AgentTool[] = []): ToolsStore => {
    let tools = [...initial];
    return {
        list: async () => tools,
        add: async (tool) => {
            tools = [...tools.filter((existing) => existing.name !== tool.name), tool];
        },
        remove: async (name) => {
            const next = tools.filter((tool) => tool.name !== name);
            const existed = next.length !== tools.length;
            tools = next;
            return existed;
        },
    };
};

const fakeDevServer = (status: Awaited<ReturnType<DevServer["status"]>>): DevServer => ({
    start: () => {},
    stop: () => {},
    status: async () => status,
});

const deps = (overrides: Partial<DaemonDeps> = {}): DaemonDeps => ({
    workspace: workspacePaths("/work"),
    devServer: fakeDevServer({ running: true, port: 5173, healthy: true }),
    // A connected account by default, so the /agent guard (no token + no env creds) doesn't short-circuit
    // turns under test. Tests that exercise the disconnected path override this.
    claudeStore: { read: async () => ({ accessToken: "tok-xyz" }), write: async () => {}, clear: async () => {} },
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
    // Drain the SSE stream (as the platform relay does) so the turn completes before we inspect the request.
    await (
        await app.request("/agent", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ prompt: "do it", sessionId: "s1", model: "opus" }),
        })
    ).text();
    expect(seen?.oauthToken).toBe("tok-xyz");
    expect(seen?.model).toBe("opus");
    expect(seen?.sessionId).toBe("s1");
});

test("POST /agent merges internal (env) tools with the sandbox's stored external tools for the turn", async () => {
    let seen: AgentRequest | undefined;
    const app = createDaemon(
        deps({
            tools: [{ name: "obs", url: "https://signoz.example.com/mcp", token: "internal" }],
            externalTools: memoryToolsStore([{ name: "linear", url: "https://mcp.linear.app/sse", token: "external" }]),
            agent: async function* (request) {
                seen = request;
                yield { kind: "done" } as AgentEvent;
            },
        }),
    );
    await (
        await app.request("/agent", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ prompt: "do it" }),
        })
    ).text();
    // Internal first, then external (last-wins on name collisions).
    expect(seen?.tools).toEqual([
        { name: "obs", url: "https://signoz.example.com/mcp", token: "internal" },
        { name: "linear", url: "https://mcp.linear.app/sse", token: "external" },
    ]);
});

test("the external-tools routes add / list (token-free) / delete against the sandbox store", async () => {
    const store = memoryToolsStore();
    const app = createDaemon(deps({ externalTools: store }));

    const add = await app.request("/workspace/tools", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "linear", url: "https://mcp.linear.app/sse", token: "lin_tok" }),
    });
    expect(add.status).toBe(200);

    // The token is never returned — it stays in the sandbox; the list only reports presence.
    const list = await (await app.request("/workspace/tools")).json();
    expect(list).toEqual({ tools: [{ name: "linear", url: "https://mcp.linear.app/sse", hasToken: true }] });

    const del = await app.request("/workspace/tools/linear", { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(await (await app.request("/workspace/tools")).json()).toEqual({ tools: [] });

    // Deleting an unknown tool is a 404.
    expect((await app.request("/workspace/tools/ghost", { method: "DELETE" })).status).toBe(404);
});

test("POST /workspace/tools rejects an invalid tool name and a bad URL", async () => {
    const app = createDaemon(deps({ externalTools: memoryToolsStore() }));
    const badName = await app.request("/workspace/tools", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "../evil", url: "https://x/mcp" }),
    });
    expect(badName.status).toBe(400);
    const badUrl = await app.request("/workspace/tools", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "ok", url: "not-a-url" }),
    });
    expect(badUrl.status).toBe(400);
});

test("POST /agent surfaces a connect-your-account error (not an opaque CLI failure) when no account and no env creds", async () => {
    delete process.env["CLAUDE_CODE_OAUTH_TOKEN"];
    delete process.env["ANTHROPIC_API_KEY"];
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
    const body = await (
        await app.request("/agent", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ prompt: "do it" }),
        })
    ).text();
    // The turn never reaches the agent — the user gets an actionable message instead of exit-code-1.
    expect(seen).toBeUndefined();
    expect(body).toContain("No Claude account connected");
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
                clone: async () => {},
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
                clone: async () => {},
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
                readBytes: async () => undefined,
                size: async () => undefined,
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
                readBytes: async () => undefined,
                size: async () => undefined,
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

    const escapeRes = await app.request("/git/intent/file", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "../escape", content: "x" }),
    });
    expect(escapeRes.status).toBe(400);
    expect(writes).toHaveLength(1);
});

test("GET /workspace/tree returns the full working tree from the walker", async () => {
    const tree = { root: "/work", tree: [{ name: "app", path: "app", type: "dir" as const, children: [] }], truncated: false };
    const app = createDaemon(deps({ workspaceTree: async () => tree }));
    const res = await app.request("/workspace/tree");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(tree);
});

test("GET /workspace/file reads any contained file, denies secrets, 404s missing, 400s escape", async () => {
    const app = createDaemon(
        deps({
            files: {
                read: async (absPath) =>
                    absPath === "/work/app/src/index.ts" ? "console.log(1);" : absPath === "/work/desired-state/.env" ? "SECRET=1" : undefined,
                write: async () => {},
                readBytes: async () => undefined,
                size: async () => undefined,
            },
        }),
    );
    // Any file under /work — untracked included, unlike the git route which is scoped to one repo.
    const ok = await app.request("/workspace/file?path=app/src/index.ts");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ path: "app/src/index.ts", content: "console.log(1);" });
    // The secret denylist short-circuits before the read, even though files.read would return the contents.
    expect((await app.request("/workspace/file?path=desired-state/.env")).status).toBe(404);
    expect((await app.request("/workspace/file?path=.intentic/claude.json")).status).toBe(404);
    // External-tool tokens live in .intentic/tools.json — also denied to the agent's file view.
    expect((await app.request("/workspace/file?path=.intentic/tools.json")).status).toBe(404);
    expect((await app.request("/workspace/file?path=app/nope.ts")).status).toBe(404);
    expect((await app.request("/workspace/file?path=../../etc/passwd")).status).toBe(400);
});

test("GET /workspace/raw streams bytes with a content-type, denies secrets, 404s missing, 400s escape, 413s oversize", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const app = createDaemon(
        deps({
            files: {
                read: async () => undefined,
                write: async () => {},
                readBytes: async (absPath) => (absPath === "/work/app/logo.png" ? png : undefined),
                size: async (absPath) =>
                    absPath === "/work/app/logo.png"
                        ? png.byteLength
                        : absPath === "/work/app/huge.png"
                          ? MAX_RAW_BYTES + 1
                          : absPath === "/work/desired-state/.env"
                            ? 10
                            : undefined,
            },
        }),
    );
    const ok = await app.request("/workspace/raw?path=app/logo.png");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await ok.arrayBuffer())).toEqual(new Uint8Array(png));
    // The denylist short-circuits before size/read, even though size would resolve.
    expect((await app.request("/workspace/raw?path=desired-state/.env")).status).toBe(404);
    // Oversize is refused on the size check, before the bytes are loaded.
    expect((await app.request("/workspace/raw?path=app/huge.png")).status).toBe(413);
    expect((await app.request("/workspace/raw?path=app/missing.png")).status).toBe(404);
    expect((await app.request("/workspace/raw?path=../../etc/passwd")).status).toBe(400);
});

test("POST /workspace/repos clones a repo, rejects reserved names + a bad body", async () => {
    const clones: { parentDir: string; name: string; cloneUrl: string }[] = [];
    const app = createDaemon(
        deps({
            git: {
                status: async () => ({ branch: "main", dirty: false, files: [] }),
                listFiles: async () => [],
                commitAll: async () => false,
                push: async () => {},
                clone: async (parentDir, name, cloneUrl) => {
                    clones.push({ parentDir, name, cloneUrl });
                },
            },
        }),
    );
    const ok = await app.request("/workspace/repos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "extra", cloneUrl: "https://example.com/extra.git" }),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ name: "extra", path: "extra" });
    expect(clones).toEqual([{ parentDir: "/work", name: "extra", cloneUrl: "https://example.com/extra.git" }]);

    // A reserved role (one of the three fixed repos) cannot be clobbered.
    const reserved = await app.request("/workspace/repos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "intent", cloneUrl: "https://example.com/x.git" }),
    });
    expect(reserved.status).toBe(400);
    // A path-escape name is rejected too.
    const escaped = await app.request("/workspace/repos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "../evil", cloneUrl: "https://example.com/x.git" }),
    });
    expect(escaped.status).toBe(400);
    expect(clones).toHaveLength(1);
});
