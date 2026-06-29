import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { type AgentEvent, type AgentRequest, runAgent } from "./agent.js";
import { resolvePlanDecision, resolveQuestionAnswer } from "./agent-requests.js";
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

const agentBody = z.object({
    prompt: z.string().min(1),
    sessionId: z.string().optional(),
    // The platform relays the user's subscription token + chosen model per turn; neither is stored here.
    oauthToken: z.string().optional(),
    model: z.string().optional(),
    // When true, run the always-plan flow (propose → approve → execute). Reasoning controls are optional.
    plan: z.boolean().optional(),
    effort: z.string().optional(),
    thinking: z.boolean().optional(),
});
// Side-channel bodies: the UI posts these to resolve a turn paused on a plan approval / question.
const decisionBody = z.object({ decisionId: z.string().min(1), approve: z.boolean(), feedback: z.string().optional() });
const answerBody = z.object({
    requestId: z.string().min(1),
    answers: z.record(z.string(), z.array(z.string())).optional(),
    cancelled: z.boolean().optional(),
});
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
                ...(parsed.data.oauthToken !== undefined ? { oauthToken: parsed.data.oauthToken } : {}),
                ...(parsed.data.model !== undefined ? { model: parsed.data.model } : {}),
                ...(parsed.data.plan !== undefined ? { plan: parsed.data.plan } : {}),
                ...(parsed.data.effort !== undefined ? { effort: parsed.data.effort } : {}),
                ...(parsed.data.thinking !== undefined ? { thinking: parsed.data.thinking } : {}),
            };
            for await (const event of agent(request)) {
                await stream.writeSSE({ data: JSON.stringify(event) });
            }
        });
    });

    // Resolve a turn paused on an ExitPlanMode approval (see agent-requests.ts). 404 when no turn is
    // waiting on that id (already answered, or the turn ended).
    app.post("/agent/decision", async (c) => {
        const parsed = decisionBody.safeParse(await c.req.json().catch(() => undefined));
        if (!parsed.success) {
            return c.json({ error: "invalid body" }, 400);
        }
        const resolved = resolvePlanDecision(parsed.data.decisionId, {
            approve: parsed.data.approve,
            ...(parsed.data.feedback !== undefined ? { feedback: parsed.data.feedback } : {}),
        });
        return resolved ? c.json({ ok: true }) : c.json({ error: "no pending plan for that decision" }, 404);
    });

    // Resolve a turn paused on an interactive question with the user's picks (or a dismissal).
    app.post("/agent/answer", async (c) => {
        const parsed = answerBody.safeParse(await c.req.json().catch(() => undefined));
        if (!parsed.success) {
            return c.json({ error: "invalid body" }, 400);
        }
        const resolved = resolveQuestionAnswer(
            parsed.data.requestId,
            parsed.data.cancelled === true ? { cancelled: true } : { answers: parsed.data.answers ?? {} },
        );
        return resolved ? c.json({ ok: true }) : c.json({ error: "no pending question for that request" }, 404);
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
