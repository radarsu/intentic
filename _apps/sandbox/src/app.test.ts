import type { AgentEvent, Capability } from "@intentic/sandbox-contract";
import { sandboxContract } from "@intentic/sandbox-contract";
import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import type { Hono } from "hono";
import { expect, test } from "vitest";
import { createApp } from "./app.js";
import type { CapabilitiesStore } from "./capabilities/capabilities-store.js";
import type { Services } from "./composition.js";
import type { Config } from "./env.config.js";
import { createLogger } from "./logger.js";
import type { DevServer } from "./system/dev-server.js";
import { mintPairing } from "./system/sync.js";
import type { AgentTool } from "./workspace/tools.js";
import { workspacePaths } from "./workspace/workspace.js";
import { MAX_RAW_BYTES } from "./workspace/workspace-files.js";

// An in-memory capabilities store so the capability routes + turn merge are testable without the fs.
const memoryCapabilitiesStore = (initial: Capability[] = []): CapabilitiesStore => {
    let capabilities = [...initial];
    return {
        list: async () => capabilities,
        get: async (id) => capabilities.find((capability) => capability.id === id),
        upsert: async (capability) => {
            capabilities = [...capabilities.filter((existing) => existing.id !== capability.id), capability];
        },
        remove: async (id) => {
            const next = capabilities.filter((capability) => capability.id !== id);
            const existed = next.length !== capabilities.length;
            capabilities = next;
            return existed;
        },
    };
};

const fakeDevServer = (status: Awaited<ReturnType<DevServer["status"]>>): DevServer => ({
    start: () => {},
    stop: () => {},
    status: async () => status,
});

// The files seam with every method a no-op by default; a test overrides just the ones it asserts on.
const fakeFiles = (overrides: Partial<Services["files"]> = {}): Services["files"] => ({
    read: async () => undefined,
    write: async () => {},
    readBytes: async () => undefined,
    size: async () => undefined,
    mkdir: async () => {},
    remove: async () => {},
    move: async () => {},
    copy: async () => {},
    ...overrides,
});

// All config fields at their schema defaults; the routes only read claudeCodeOauthToken / anthropicApiKey
// (the agent guard) and the workspace paths (via services.workspace), so the rest are inert here.
const baseConfig: Config = {
    workspaceRoot: "/work",
    logLevel: "silent",
    logPretty: false,
    zone: "",
    connectToken: "",
    webOrigin: "",
    platformUrl: "",
    intenticAgentTools: "",
    claudeCodeOauthToken: "",
    anthropicApiKey: "",
    sandbox: { port: 8787, host: "0.0.0.0", publicUrl: "", name: "", image: "" },
    dev: { command: "", port: "" },
    google: { clientId: "" },
};

const services = (overrides: Partial<Services> = {}): Services => ({
    config: baseConfig,
    logger: createLogger(baseConfig),
    workspace: workspacePaths("/work"),
    devServer: fakeDevServer({ running: true, port: 5173, healthy: true }),
    info: undefined,
    tools: [],
    capabilities: memoryCapabilitiesStore(),
    // A connected account by default, so the /agent guard (no token + no env creds) doesn't short-circuit
    // turns under test. Tests that exercise the disconnected path override this.
    claudeStore: { read: async () => ({ accessToken: "tok-xyz" }), write: async () => {}, clear: async () => {} },
    agent: async function* () {
        yield { kind: "done" };
    },
    intentic: async function* () {},
    git: {
        init: async () => {},
        status: async () => ({ branch: "main", dirty: false, files: [] }),
        listFiles: async () => [],
        commitAll: async () => false,
        push: async () => {},
        clone: async () => {},
    },
    files: fakeFiles(),
    workspaceTree: async () => ({ root: "/work", tree: [], truncated: false }),
    sessions: { list: async () => [], read: async () => [] },
    members: { list: async () => [], add: async () => {}, remove: async () => {} },
    auth: undefined,
    ...overrides,
});

// A typed oRPC client over the in-process Hono app — the same OpenAPILink the browser uses, so streams round-
// trip through the real SSE encode/decode. JSON routes resolve to their output; thrown ORPCErrors carry `.code`.
const clientFor = (app: Hono): ContractRouterClient<typeof sandboxContract> =>
    createORPCClient(new OpenAPILink(sandboxContract, { url: "http://sandbox", fetch: (request) => app.request(request) }));

const errorCode = async (run: Promise<unknown>): Promise<string | undefined> => {
    try {
        await run;
    } catch (error) {
        return (error as { code?: string }).code;
    }
    return undefined;
};

const collect = async (stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> => {
    const events: AgentEvent[] = [];
    for await (const event of stream) {
        events.push(event);
    }
    return events;
};

test("GET /health reports ok", async () => {
    const res = await createApp(services()).request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
});

test("system.preview returns the dev server status", async () => {
    const client = clientFor(createApp(services()));
    expect(await client.system.preview()).toEqual({ running: true, port: 5173, healthy: true });
});

test("POST /enroll rejects a wrong connect token and 412s until DevOps (when auth is enforced)", async () => {
    const app = createApp(services({ auth: { authorize: async () => {}, authorizeOwner: async () => {} }, config: { ...baseConfig, connectToken: "ct" } }));
    const enroll = (token: string) =>
        app.request("/enroll", {
            method: "POST",
            headers: { "content-type": "application/json", "x-intentic-connect": token },
            body: JSON.stringify({ name: "prod", user: "deploy", address: "ssh-x.zone", sshKey: "KEY" }),
        });
    expect((await enroll("wrong")).status).toBe(401);
    // Right token, but the desired-state repo is absent under test → 412 (DevOps not active).
    expect((await enroll("ct")).status).toBe(412);
});

test("POST /system/authorized-key authorizes via the pairing token alone (no bearer)", async () => {
    const reject = async (): Promise<void> => {
        throw new Error("no bearer");
    };
    const app = createApp(services({ auth: { authorize: reject, authorizeOwner: reject } }));
    // Empty body: a valid pairing must get past auth and fail on key validation (400), never on auth (401) —
    // the regression was the global bearer middleware 401ing before the route's own pairing check ran.
    const post = (headers: Record<string, string> = {}) =>
        app.request("/system/authorized-key", {
            method: "POST",
            headers: { "content-type": "application/json", ...headers },
            body: JSON.stringify({}),
        });
    expect((await post({ "x-intentic-pair": mintPairing().token })).status).toBe(400);
    expect((await post()).status).toBe(401);
    expect((await post({ "x-intentic-pair": "bogus" })).status).toBe(401);
});

test("agent.run streams the agent events", async () => {
    const events: AgentEvent[] = [{ kind: "session", sessionId: "s1" }, { kind: "delta", text: "hi" }, { kind: "done" }];
    const client = clientFor(
        createApp(
            services({
                agent: async function* () {
                    yield* events;
                },
            }),
        ),
    );
    expect(await collect(await client.agent.run({ prompt: "do it" }))).toEqual(events);
});

test("agent.run resolves the oauth token from the sandbox store (not the body) and forwards model/session", async () => {
    let seen: { oauthToken?: string; model?: string; sessionId?: string } | undefined;
    const client = clientFor(
        createApp(
            services({
                claudeStore: { read: async () => ({ accessToken: "tok-xyz" }), write: async () => {}, clear: async () => {} },
                agent: async function* (request) {
                    seen = request;
                    yield { kind: "done" };
                },
            }),
        ),
    );
    await collect(await client.agent.run({ prompt: "do it", sessionId: "s1", model: "opus" }));
    expect(seen?.oauthToken).toBe("tok-xyz");
    expect(seen?.model).toBe("opus");
    expect(seen?.sessionId).toBe("s1");
});

test("agent.run merges internal (env) tools with the mcp-kind capabilities for the turn", async () => {
    let seen: { tools?: readonly AgentTool[] } | undefined;
    const client = clientFor(
        createApp(
            services({
                tools: [{ name: "obs", url: "https://signoz.example.com/mcp", token: "internal" }],
                capabilities: memoryCapabilitiesStore([{ id: "linear", kind: "mcp", config: { url: "https://mcp.linear.app/sse", token: "external" } }]),
                agent: async function* (request) {
                    seen = request;
                    yield { kind: "done" };
                },
            }),
        ),
    );
    await collect(await client.agent.run({ prompt: "do it" }));
    // Internal first, then external mcp capabilities (last-wins on name collisions).
    expect(seen?.tools).toEqual([
        { name: "obs", url: "https://signoz.example.com/mcp", token: "internal" },
        { name: "linear", url: "https://mcp.linear.app/sse", token: "external" },
    ]);
});

test("capabilities.list reports each capability with its status; devops can't be removed, unknown is NOT_FOUND", async () => {
    const client = clientFor(createApp(services({ capabilities: memoryCapabilitiesStore([{ id: "devops", kind: "devops", config: {} }]) })));
    // devops status is derived from the repos on disk — absent under test, so it reads inactive.
    expect(await client.capabilities.list()).toEqual({
        capabilities: [{ id: "devops", kind: "devops", status: { state: "inactive" }, config: {} }],
    });
    // DevOps has no teardown (deleting the repos is data loss) → CONFLICT; an unknown id is NOT_FOUND.
    expect(await errorCode(client.capabilities.remove({ id: "devops" }))).toBe("CONFLICT");
    expect(await errorCode(client.capabilities.remove({ id: "ghost" }))).toBe("NOT_FOUND");
});

test("secrets.set / list refuse until DevOps is active (the desired-state repo is absent under test)", async () => {
    const client = clientFor(createApp(services()));
    expect(await errorCode(client.secrets.set({ key: "CLOUDFLARE_API_TOKEN", value: "x" }))).toBe("PRECONDITION_FAILED");
    expect(await errorCode(client.secrets.list())).toBe("PRECONDITION_FAILED");
});

test("agent.run surfaces a connect-your-account error (not an opaque CLI failure) when no account and no env creds", async () => {
    let agentCalled = false;
    const client = clientFor(
        createApp(
            services({
                claudeStore: { read: async () => undefined, write: async () => {}, clear: async () => {} },
                agent: async function* () {
                    agentCalled = true;
                    yield { kind: "done" };
                },
            }),
        ),
    );
    const events = await collect(await client.agent.run({ prompt: "do it" }));
    // The turn never reaches the agent — the user gets an actionable message instead of exit-code-1.
    expect(agentCalled).toBe(false);
    expect(events.some((event) => event.kind === "error" && event.message.includes("No Claude account connected"))).toBe(true);
});

test("Claude OAuth: account status reflects the store, disconnect clears it", async () => {
    let stored: { accessToken: string; scope?: string } | undefined;
    const client = clientFor(
        createApp(
            services({
                claudeStore: {
                    read: async () => stored,
                    write: async (account) => {
                        stored = account;
                    },
                    clear: async () => {
                        stored = undefined;
                    },
                },
            }),
        ),
    );
    expect(await client.claude.account()).toEqual({ connected: false });
    // The start route hands the browser an authorize URL + PKCE material.
    const challenge = await client.claude.start();
    expect(typeof challenge.authorizeUrl).toBe("string");
    expect(typeof challenge.verifier).toBe("string");

    // Directly store (exchange itself hits Anthropic; the store wiring is what we assert here).
    stored = { accessToken: "tok", scope: "user:inference" };
    expect(await client.claude.account()).toEqual({ connected: true, scope: "user:inference" });
    expect(await client.claude.disconnect()).toEqual({ ok: true });
    expect(stored).toBeUndefined();
});

test("agent.run rejects an empty prompt", async () => {
    const client = clientFor(createApp(services()));
    expect(await errorCode(client.agent.run({ prompt: "" }))).toBe("BAD_REQUEST");
});

test("git.status resolves the repo dir, and rejects an unknown repo", async () => {
    const seen: string[] = [];
    const client = clientFor(
        createApp(
            services({
                git: {
                    init: async () => {},
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
        ),
    );
    expect(await client.git.status({ repo: "app" })).toEqual({ branch: "main", dirty: false, files: [] });
    expect(seen).toEqual(["/work/repositories/app"]);
    expect(await errorCode(client.git.status({ repo: "nope" }))).toBe("NOT_FOUND");
});

test("git.files lists the repo's tracked files", async () => {
    const client = clientFor(
        createApp(
            services({
                git: {
                    init: async () => {},
                    status: async () => ({ branch: "main", dirty: false, files: [] }),
                    listFiles: async (dir) => (dir === "/work/repositories/intent" ? ["deploy.config.ts", "package.json"] : []),
                    commitAll: async () => false,
                    push: async () => {},
                    clone: async () => {},
                },
            }),
        ),
    );
    expect(await client.git.files({ repo: "intent" })).toEqual({ files: ["deploy.config.ts", "package.json"] });
});

test("git.readFile reads a contained file, NOT_FOUNDs a missing one, and BAD_REQUESTs a path escape", async () => {
    const client = clientFor(
        createApp(
            services({
                files: fakeFiles({ read: async (absPath) => (absPath === "/work/repositories/intent/deploy.config.ts" ? "export const intent = 1;" : undefined) }),
            }),
        ),
    );
    expect(await client.git.readFile({ repo: "intent", path: "deploy.config.ts" })).toEqual({
        path: "deploy.config.ts",
        content: "export const intent = 1;",
    });
    expect(await errorCode(client.git.readFile({ repo: "intent", path: "nope.ts" }))).toBe("NOT_FOUND");
    expect(await errorCode(client.git.readFile({ repo: "intent", path: "../../etc/passwd" }))).toBe("BAD_REQUEST");
});

test("git.writeFile writes a contained file and rejects a path escape", async () => {
    const writes: { path: string; content: string | Uint8Array }[] = [];
    const client = clientFor(
        createApp(
            services({
                files: fakeFiles({
                    write: async (absPath, content) => {
                        writes.push({ path: absPath, content });
                    },
                }),
            }),
        ),
    );
    expect(await client.git.writeFile({ repo: "intent", path: "deploy.config.ts", content: "next" })).toEqual({ ok: true });
    expect(writes).toEqual([{ path: "/work/repositories/intent/deploy.config.ts", content: "next" }]);
    expect(await errorCode(client.git.writeFile({ repo: "intent", path: "../escape", content: "x" }))).toBe("BAD_REQUEST");
    expect(writes).toHaveLength(1);
});

test("workspace.tree returns the full working tree from the walker", async () => {
    const tree = { root: "/work", tree: [{ name: "app", path: "app", type: "dir" as const, children: [] }], truncated: false };
    const client = clientFor(createApp(services({ workspaceTree: async () => tree })));
    expect(await client.workspace.tree()).toEqual(tree);
});

test("workspace.file reads any contained file, denies secrets, NOT_FOUNDs missing, BAD_REQUESTs escape", async () => {
    const client = clientFor(
        createApp(
            services({
                files: fakeFiles({
                    read: async (absPath) =>
                        absPath === "/work/app/src/index.ts" ? "console.log(1);" : absPath === "/work/desired-state/.env" ? "SECRET=1" : undefined,
                }),
            }),
        ),
    );
    expect(await client.workspace.file({ path: "app/src/index.ts" })).toEqual({ path: "app/src/index.ts", content: "console.log(1);" });
    // The secret denylist short-circuits before the read, even though files.read would return the contents.
    expect(await errorCode(client.workspace.file({ path: "desired-state/.env" }))).toBe("NOT_FOUND");
    expect(await errorCode(client.workspace.file({ path: ".intentic/claude.json" }))).toBe("NOT_FOUND");
    expect(await errorCode(client.workspace.file({ path: ".intentic/capabilities.json" }))).toBe("NOT_FOUND");
    expect(await errorCode(client.workspace.file({ path: "app/nope.ts" }))).toBe("NOT_FOUND");
    expect(await errorCode(client.workspace.file({ path: "../../etc/passwd" }))).toBe("BAD_REQUEST");
});

test("GET /workspace/raw streams bytes with a content-type, denies secrets, 404s missing, 400s escape, 413s oversize", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const app = createApp(
        services({
            files: fakeFiles({
                readBytes: async (absPath) => (absPath === "/work/app/logo.png" ? png : undefined),
                size: async (absPath) =>
                    absPath === "/work/app/logo.png"
                        ? png.byteLength
                        : absPath === "/work/app/huge.png"
                          ? MAX_RAW_BYTES + 1
                          : absPath === "/work/desired-state/.env"
                            ? 10
                            : undefined,
            }),
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

test("POST /workspace/upload writes bytes, denies secrets/.git, 400s escape, 413s oversize", async () => {
    const writes: { path: string; content: string | Uint8Array }[] = [];
    const app = createApp(
        services({
            files: fakeFiles({
                write: async (absPath, content) => {
                    writes.push({ path: absPath, content });
                },
            }),
        }),
    );
    const body = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

    const ok = await app.request("/workspace/upload?path=app/assets/logo.png", { method: "POST", body });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe("/work/app/assets/logo.png");
    expect(new Uint8Array(writes[0]?.content as Uint8Array)).toEqual(body);

    // Same guards as the read routes: the secret/.git denylist is 404, a climb-out is 400 — neither writes.
    expect((await app.request("/workspace/upload?path=desired-state/.env", { method: "POST", body })).status).toBe(404);
    expect((await app.request("/workspace/upload?path=.intentic/claude.json", { method: "POST", body })).status).toBe(404);
    expect((await app.request("/workspace/upload?path=../../etc/passwd", { method: "POST", body })).status).toBe(400);

    // Oversize is refused on the body length; nothing new is written.
    const oversize = await app.request("/workspace/upload?path=app/huge.bin", { method: "POST", body: new Uint8Array(MAX_RAW_BYTES + 1) });
    expect(oversize.status).toBe(413);
    expect(writes).toHaveLength(1);
});

test("workspace.mkdir/delete/move/copy resolve within /work and guard escapes + secrets", async () => {
    const calls: [string, ...string[]][] = [];
    const client = clientFor(
        createApp(
            services({
                files: fakeFiles({
                    mkdir: async (p) => {
                        calls.push(["mkdir", p]);
                    },
                    remove: async (p) => {
                        calls.push(["remove", p]);
                    },
                    move: async (a, b) => {
                        calls.push(["move", a, b]);
                    },
                    copy: async (a, b) => {
                        calls.push(["copy", a, b]);
                    },
                }),
            }),
        ),
    );

    expect(await client.workspace.mkdir({ path: "app/new-dir" })).toEqual({ ok: true });
    expect(await client.workspace.delete({ path: "app/old.ts" })).toEqual({ ok: true });
    expect(await client.workspace.move({ from: "app/a.ts", to: "app/b.ts" })).toEqual({ ok: true });
    expect(await client.workspace.copy({ from: "app/a.ts", to: "app/nested/c.ts" })).toEqual({ ok: true });
    expect(calls).toEqual([
        ["mkdir", "/work/app/new-dir"],
        ["remove", "/work/app/old.ts"],
        ["move", "/work/app/a.ts", "/work/app/b.ts"],
        ["copy", "/work/app/a.ts", "/work/app/nested/c.ts"],
    ]);

    // Guards fire on either endpoint, before the fs is touched.
    expect(await errorCode(client.workspace.mkdir({ path: "../evil" }))).toBe("BAD_REQUEST");
    expect(await errorCode(client.workspace.delete({ path: "desired-state/.env" }))).toBe("NOT_FOUND");
    expect(await errorCode(client.workspace.move({ from: "app/a.ts", to: "../escape" }))).toBe("BAD_REQUEST");
    expect(await errorCode(client.workspace.move({ from: ".git/config", to: "app/x" }))).toBe("NOT_FOUND");
    expect(await errorCode(client.workspace.copy({ from: "app/a.ts", to: "app/.env" }))).toBe("NOT_FOUND");
    expect(calls).toHaveLength(4);
});

test("workspace.addRepo clones a repo, rejects reserved names + a bad body", async () => {
    const clones: { parentDir: string; name: string; cloneUrl: string }[] = [];
    const client = clientFor(
        createApp(
            services({
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
        ),
    );
    expect(await client.workspace.addRepo({ name: "extra", cloneUrl: "https://example.com/extra.git" })).toEqual({ name: "extra", path: "extra" });
    expect(clones).toEqual([{ parentDir: "/work/repositories", name: "extra", cloneUrl: "https://example.com/extra.git" }]);
    // A reserved role (one of the three fixed repos) cannot be clobbered, and a path-escape name is rejected.
    expect(await errorCode(client.workspace.addRepo({ name: "intent", cloneUrl: "https://example.com/x.git" }))).toBe("BAD_REQUEST");
    expect(await errorCode(client.workspace.addRepo({ name: "../evil", cloneUrl: "https://example.com/x.git" }))).toBe("BAD_REQUEST");
    expect(clones).toHaveLength(1);
});
