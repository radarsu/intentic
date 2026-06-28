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

test("POST /agent forwards the per-turn oauth token and model into the agent request", async () => {
    let seen: AgentRequest | undefined;
    const app = createDaemon(
        deps({
            agent: async function* (request) {
                seen = request;
                yield { kind: "done" } as AgentEvent;
            },
        }),
    );
    await app.request("/agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "do it", sessionId: "s1", oauthToken: "tok-xyz", model: "opus" }),
    });
    expect(seen?.oauthToken).toBe("tok-xyz");
    expect(seen?.model).toBe("opus");
    expect(seen?.sessionId).toBe("s1");
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
                commitAll: async () => false,
                push: async () => {},
            },
        }),
    );
    expect((await app.request("/git/app/status")).status).toBe(200);
    expect(seen).toEqual(["/work/app"]);
    expect((await app.request("/git/nope/status")).status).toBe(404);
});
