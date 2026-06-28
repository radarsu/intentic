import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { type AgentEvent, type AgentRequest, runAgent } from "./agent.js";
import type { DevServer } from "./dev-server.js";
import { gitCommitAll, gitPush, gitStatus } from "./git.js";
import { type IntenticLine, type IntenticRun, runIntentic } from "./intentic-runner.js";
import { REPO_ROLES, type RepoRole, type WorkspacePaths } from "./workspace.js";

// The daemon's collaborators, injected so the HTTP wiring is testable without real subprocesses.
export interface DaemonDeps {
    readonly workspace: WorkspacePaths;
    readonly devServer: DevServer;
    readonly agent?: (request: AgentRequest) => AsyncIterable<AgentEvent>;
    readonly intentic?: (run: IntenticRun) => AsyncIterable<IntenticLine>;
    readonly git?: {
        readonly status: (dir: string) => Promise<unknown>;
        readonly commitAll: (dir: string, message: string, author: { name: string; email: string }) => Promise<boolean>;
        readonly push: (dir: string, branch: string) => Promise<void>;
    };
}

const COMMIT_AUTHOR = { name: "intentic", email: "agent@intentic.dev" } as const;

const agentBody = z.object({ prompt: z.string().min(1), sessionId: z.string().optional() });
const intenticBody = z.object({ args: z.array(z.string()) });
const commitBody = z.object({ message: z.string().min(1) });
const pushBody = z.object({ branch: z.string().min(1) });

// The local HTTP API the runner drives (and relays to the UI). Bound to 127.0.0.1 by main.ts — the runner
// reaches it on the loopback, so the daemon itself is unauthenticated; the runner owns auth to the platform.
export const createDaemon = (deps: DaemonDeps): Hono => {
    const { workspace, devServer } = deps;
    const agent = deps.agent ?? ((request) => runAgent(request));
    const intentic = deps.intentic ?? ((run) => runIntentic(run));
    const git = deps.git ?? {
        status: (dir) => gitStatus(dir),
        commitAll: (dir, message, author) => gitCommitAll(dir, message, author),
        push: (dir, branch) => gitPush(dir, branch),
    };

    const repoDir = (param: string): string | undefined =>
        (REPO_ROLES as readonly string[]).includes(param) ? workspace.repos[param as RepoRole] : undefined;

    const app = new Hono();

    app.get("/health", (c) => c.json({ ok: true }));
    app.get("/preview", async (c) => c.json(await devServer.status()));

    app.post("/agent", async (c) => {
        const parsed = agentBody.safeParse(await c.req.json().catch(() => undefined));
        if (!parsed.success) {
            return c.json({ error: "invalid body" }, 400);
        }
        return streamSSE(c, async (stream) => {
            const request: AgentRequest = {
                prompt: parsed.data.prompt,
                cwd: workspace.root,
                signal: c.req.raw.signal,
                ...(parsed.data.sessionId !== undefined ? { sessionId: parsed.data.sessionId } : {}),
            };
            for await (const event of agent(request)) {
                await stream.writeSSE({ data: JSON.stringify(event) });
            }
        });
    });

    app.post("/intentic", async (c) => {
        const parsed = intenticBody.safeParse(await c.req.json().catch(() => undefined));
        if (!parsed.success) {
            return c.json({ error: "invalid body" }, 400);
        }
        return streamSSE(c, async (stream) => {
            for await (const line of intentic({ args: parsed.data.args, cwd: workspace.root })) {
                await stream.writeSSE({ data: JSON.stringify(line) });
            }
        });
    });

    app.get("/git/:repo/status", async (c) => {
        const dir = repoDir(c.req.param("repo"));
        if (dir === undefined) {
            return c.json({ error: "unknown repo" }, 404);
        }
        return c.json(await git.status(dir));
    });

    app.post("/git/:repo/commit", async (c) => {
        const dir = repoDir(c.req.param("repo"));
        if (dir === undefined) {
            return c.json({ error: "unknown repo" }, 404);
        }
        const parsed = commitBody.safeParse(await c.req.json().catch(() => undefined));
        if (!parsed.success) {
            return c.json({ error: "invalid body" }, 400);
        }
        return c.json({ committed: await git.commitAll(dir, parsed.data.message, COMMIT_AUTHOR) });
    });

    app.post("/git/:repo/push", async (c) => {
        const dir = repoDir(c.req.param("repo"));
        if (dir === undefined) {
            return c.json({ error: "unknown repo" }, 404);
        }
        const parsed = pushBody.safeParse(await c.req.json().catch(() => undefined));
        if (!parsed.success) {
            return c.json({ error: "invalid body" }, 400);
        }
        await git.push(dir, parsed.data.branch);
        return c.json({ ok: true });
    });

    return app;
};
