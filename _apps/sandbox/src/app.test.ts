import type { AgentEvent, SelfHost } from "@intentic/sandbox-contract";
import { sandboxContract } from "@intentic/sandbox-contract";
import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import type { Hono } from "hono";
import { expect, test } from "vitest";
import { createApp } from "./app.js";
import type { Services } from "./composition.js";
import type { DevServer } from "./dev-server.js";
import type { Config } from "./env.config.js";
import { createLogger } from "./logger.js";
import type { AgentTool } from "./tools.js";
import type { ToolsStore } from "./tools-store.js";
import { workspacePaths } from "./workspace.js";
import { MAX_RAW_BYTES } from "./workspace-files.js";

// An in-memory external-tools store so the tool routes + turn merge are testable without the fs.
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

// All config fields at their schema defaults; the routes only read claudeCodeOauthToken / anthropicApiKey
// (the agent guard) and the workspace paths (via services.workspace), so the rest are inert here.
const baseConfig: Config = {
    workspaceRoot: "/work",
    logLevel: "silent",
    logPretty: false,
    zone: "",
    hostSshKey: "",
    connectToken: "",
    webOrigin: "",
    platformUrl: "",
    intenticAgentTools: "",
    claudeCodeOauthToken: "",
    anthropicApiKey: "",
    sandbox: { port: 8787, host: "0.0.0.0", publicUrl: "", name: "", image: "" },
    dev: { command: "", port: "" },
    google: { clientId: "" },
    selfHost: { user: "", address: "host.docker.internal" },
};

const services = (overrides: Partial<Services> = {}): Services => ({
    config: baseConfig,
    logger: createLogger(baseConfig),
    workspace: workspacePaths("/work"),
    devServer: fakeDevServer({ running: true, port: 5173, healthy: true }),
    selfHost: undefined,
    info: undefined,
    tools: [],
    externalTools: memoryToolsStore(),
    // A connected account by default, so the /agent guard (no token + no env creds) doesn't short-circuit
    // turns under test. Tests that exercise the disconnected path override this.
    claudeStore: { read: async () => ({ accessToken: "tok-xyz" }), write: async () => {}, clear: async () => {} },
    agent: async function* () {
        yield { kind: "done" };
    },
    intentic: async function* () {},
    git: {
        status: async () => ({ branch: "main", dirty: false, files: [] }),
        listFiles: async () => [],
        commitAll: async () => false,
        push: async () => {},
        clone: async () => {},
    },
    files: { read: async () => undefined, write: async () => {}, readBytes: async () => undefined, size: async () => undefined },
    workspaceTree: async () => ({ root: "/work", tree: [], truncated: false }),
    sessions: { list: async () => [], read: async () => [] },
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

test("system.selfHost reports null by default, and the host descriptor when wired", async () => {
    expect(await clientFor(createApp(services())).system.selfHost()).toEqual({ selfHost: null });
    const wired: SelfHost = { user: "intentic", address: "host.docker.internal", port: 22 };
    expect(await clientFor(createApp(services({ selfHost: wired }))).system.selfHost()).toEqual({ selfHost: wired });
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

test("agent.run merges internal (env) tools with the sandbox's stored external tools for the turn", async () => {
    let seen: { tools?: readonly AgentTool[] } | undefined;
    const client = clientFor(
        createApp(
            services({
                tools: [{ name: "obs", url: "https://signoz.example.com/mcp", token: "internal" }],
                externalTools: memoryToolsStore([{ name: "linear", url: "https://mcp.linear.app/sse", token: "external" }]),
                agent: async function* (request) {
                    seen = request;
                    yield { kind: "done" };
                },
            }),
        ),
    );
    await collect(await client.agent.run({ prompt: "do it" }));
    // Internal first, then external (last-wins on name collisions).
    expect(seen?.tools).toEqual([
        { name: "obs", url: "https://signoz.example.com/mcp", token: "internal" },
        { name: "linear", url: "https://mcp.linear.app/sse", token: "external" },
    ]);
});

test("the external-tools routes add / list (token-free) / delete against the sandbox store", async () => {
    const client = clientFor(createApp(services({ externalTools: memoryToolsStore() })));

    expect(await client.workspace.addTool({ name: "linear", url: "https://mcp.linear.app/sse", token: "lin_tok" })).toEqual({ name: "linear" });
    // The token is never returned — it stays in the sandbox; the list only reports presence.
    expect(await client.workspace.tools()).toEqual({ tools: [{ name: "linear", url: "https://mcp.linear.app/sse", hasToken: true }] });
    expect(await client.workspace.removeTool({ name: "linear" })).toEqual({ ok: true });
    expect(await client.workspace.tools()).toEqual({ tools: [] });
    // Deleting an unknown tool is NOT_FOUND.
    expect(await errorCode(client.workspace.removeTool({ name: "ghost" }))).toBe("NOT_FOUND");
});

test("workspace.addTool rejects an invalid tool name and a bad URL", async () => {
    const client = clientFor(createApp(services({ externalTools: memoryToolsStore() })));
    expect(await errorCode(client.workspace.addTool({ name: "../evil", url: "https://x/mcp" }))).toBe("BAD_REQUEST");
    expect(await errorCode(client.workspace.addTool({ name: "ok", url: "not-a-url" }))).toBe("BAD_REQUEST");
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
    expect(seen).toEqual(["/work/app"]);
    expect(await errorCode(client.git.status({ repo: "nope" }))).toBe("NOT_FOUND");
});

test("git.files lists the repo's tracked files", async () => {
    const client = clientFor(
        createApp(
            services({
                git: {
                    status: async () => ({ branch: "main", dirty: false, files: [] }),
                    listFiles: async (dir) => (dir === "/work/intent" ? ["deploy.config.ts", "package.json"] : []),
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
                files: {
                    read: async (absPath) => (absPath === "/work/intent/deploy.config.ts" ? "export const intent = 1;" : undefined),
                    write: async () => {},
                    readBytes: async () => undefined,
                    size: async () => undefined,
                },
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
    const writes: { path: string; content: string }[] = [];
    const client = clientFor(
        createApp(
            services({
                files: {
                    read: async () => undefined,
                    write: async (absPath, content) => {
                        writes.push({ path: absPath, content });
                    },
                    readBytes: async () => undefined,
                    size: async () => undefined,
                },
            }),
        ),
    );
    expect(await client.git.writeFile({ repo: "intent", path: "deploy.config.ts", content: "next" })).toEqual({ ok: true });
    expect(writes).toEqual([{ path: "/work/intent/deploy.config.ts", content: "next" }]);
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
                files: {
                    read: async (absPath) =>
                        absPath === "/work/app/src/index.ts" ? "console.log(1);" : absPath === "/work/desired-state/.env" ? "SECRET=1" : undefined,
                    write: async () => {},
                    readBytes: async () => undefined,
                    size: async () => undefined,
                },
            }),
        ),
    );
    expect(await client.workspace.file({ path: "app/src/index.ts" })).toEqual({ path: "app/src/index.ts", content: "console.log(1);" });
    // The secret denylist short-circuits before the read, even though files.read would return the contents.
    expect(await errorCode(client.workspace.file({ path: "desired-state/.env" }))).toBe("NOT_FOUND");
    expect(await errorCode(client.workspace.file({ path: ".intentic/claude.json" }))).toBe("NOT_FOUND");
    expect(await errorCode(client.workspace.file({ path: ".intentic/tools.json" }))).toBe("NOT_FOUND");
    expect(await errorCode(client.workspace.file({ path: "app/nope.ts" }))).toBe("NOT_FOUND");
    expect(await errorCode(client.workspace.file({ path: "../../etc/passwd" }))).toBe("BAD_REQUEST");
});

test("GET /workspace/raw streams bytes with a content-type, denies secrets, 404s missing, 400s escape, 413s oversize", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const app = createApp(
        services({
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
    expect(clones).toEqual([{ parentDir: "/work", name: "extra", cloneUrl: "https://example.com/extra.git" }]);
    // A reserved role (one of the three fixed repos) cannot be clobbered, and a path-escape name is rejected.
    expect(await errorCode(client.workspace.addRepo({ name: "intent", cloneUrl: "https://example.com/x.git" }))).toBe("BAD_REQUEST");
    expect(await errorCode(client.workspace.addRepo({ name: "../evil", cloneUrl: "https://example.com/x.git" }))).toBe("BAD_REQUEST");
    expect(clones).toHaveLength(1);
});
