import { join } from "node:path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { type AgentEvent, type AgentRequest, runAgent } from "./agent.js";
import { resolvePlanDecision, resolveQuestionAnswer } from "./agent-requests.js";
import { buildAuthorizeUrl, type ClaudeStore, ensureFreshToken, exchangeCode, fileClaudeStore } from "./claude-credentials.js";
import type { DevServer } from "./dev-server.js";
import { gitCommitAll, gitListFiles, gitPush, gitStatus } from "./git.js";
import { type IntenticLine, type IntenticRun, runIntentic } from "./intentic-runner.js";
import { listWorkspaceSessions, readWorkspaceSession, type SessionSummary, type SessionTranscriptMessage } from "./sessions.js";
import { REPO_ROLES, type RepoRole, type WorkspacePaths } from "./workspace.js";
import { readWorkspaceFile, resolveWithin, writeWorkspaceFile } from "./workspace-files.js";

// The daemon's collaborators, injected so the HTTP wiring is testable without real subprocesses.
export interface DaemonDeps {
    readonly workspace: WorkspacePaths;
    readonly devServer: DevServer;
    readonly agent?: (request: AgentRequest) => AsyncIterable<AgentEvent>;
    readonly intentic?: (run: IntenticRun) => AsyncIterable<IntenticLine>;
    // The sandbox-owned Claude credential store (the platform no longer holds the token). Defaults to a JSON
    // file beside the workspace; injected in tests.
    readonly claudeStore?: ClaudeStore;
    readonly git?: {
        readonly status: (dir: string) => Promise<unknown>;
        readonly listFiles: (dir: string) => Promise<readonly string[]>;
        readonly commitAll: (dir: string, message: string, author: { name: string; email: string }) => Promise<boolean>;
        readonly push: (dir: string, branch: string) => Promise<void>;
    };
    // Repo-contained file read/write (the platform reads/edits deploy.config.ts + views source through these,
    // instead of holding a git token). Paths are guarded against escaping the repo by the routes.
    readonly files?: {
        readonly read: (absPath: string) => Promise<string | undefined>;
        readonly write: (absPath: string, content: string) => Promise<void>;
    };
    // Past-conversation history: the Claude Agent SDK persists sessions on disk keyed by the workspace dir;
    // the platform relays these for the chat history menu. Injected in tests.
    readonly sessions?: {
        readonly list: (dir: string) => Promise<SessionSummary[]>;
        readonly read: (dir: string, id: string) => Promise<SessionTranscriptMessage[]>;
    };
}

const COMMIT_AUTHOR = { name: "intentic", email: "agent@intentic.dev" } as const;

const agentBody = z.object({
    prompt: z.string().min(1),
    sessionId: z.string().optional(),
    // The platform relays the chosen model per turn; the Claude token is the sandbox's own stored credential.
    model: z.string().optional(),
    // When true, run the always-plan flow (propose → approve → execute). Reasoning controls are optional.
    plan: z.boolean().optional(),
    effort: z.string().optional(),
    thinking: z.boolean().optional(),
});
// The platform UI relays the Claude OAuth handshake to the sandbox, which stores the resulting tokens; the
// verifier/state round-trip through the browser (public client), so the sandbox keeps no pending-auth state.
const claudeExchangeBody = z.object({ code: z.string().min(1), verifier: z.string().min(1), state: z.string().min(1) });
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
const fileWriteBody = z.object({ path: z.string().min(1), content: z.string() });

// The local HTTP API the runner drives (and relays to the UI). Bound to 127.0.0.1 by main.ts — the runner
// reaches it on the loopback, so the daemon itself is unauthenticated; the runner owns auth to the platform.
export const createDaemon = (deps: DaemonDeps): Hono => {
    const { workspace, devServer } = deps;
    const agent = deps.agent ?? ((request) => runAgent(request));
    const intentic = deps.intentic ?? ((run) => runIntentic(run));
    const git = deps.git ?? {
        status: (dir) => gitStatus(dir),
        listFiles: (dir) => gitListFiles(dir),
        commitAll: (dir, message, author) => gitCommitAll(dir, message, author),
        push: (dir, branch) => gitPush(dir, branch),
    };
    const files = deps.files ?? { read: (absPath) => readWorkspaceFile(absPath), write: (absPath, content) => writeWorkspaceFile(absPath, content) };
    const sessions = deps.sessions ?? { list: (dir) => listWorkspaceSessions(dir), read: (dir, id) => readWorkspaceSession(dir, id) };
    const claudeStore = deps.claudeStore ?? fileClaudeStore(join(workspace.root, ".intentic", "claude.json"));

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
            // The Claude token is the sandbox's own credential (resolved + refreshed here), not relayed by the
            // platform. undefined means no account is connected — the SDK then falls back to the container env.
            let oauthToken: string | undefined;
            try {
                oauthToken = await ensureFreshToken(claudeStore);
            } catch (error) {
                const message = error instanceof Error ? error.message : "claude credentials unavailable";
                await stream.writeSSE({ data: JSON.stringify({ kind: "error", message } satisfies AgentEvent) });
                await stream.writeSSE({ data: JSON.stringify({ kind: "done" } satisfies AgentEvent) });
                return;
            }
            const request: AgentRequest = {
                prompt: parsed.data.prompt,
                cwd: workspace.root,
                signal: c.req.raw.signal,
                ...(parsed.data.sessionId !== undefined ? { sessionId: parsed.data.sessionId } : {}),
                ...(oauthToken !== undefined ? { oauthToken } : {}),
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

    // Claude subscription OAuth — the sandbox owns the credential. `start` returns the authorize URL + the
    // PKCE verifier/state the browser round-trips back to `exchange`, which stores the tokens here. The agent
    // turns above read them; the platform never sees the token.
    app.post("/claude/oauth/start", (c) => c.json(buildAuthorizeUrl()));

    app.post("/claude/oauth/exchange", async (c) => {
        const parsed = claudeExchangeBody.safeParse(await c.req.json().catch(() => undefined));
        if (!parsed.success) {
            return c.json({ error: "invalid body" }, 400);
        }
        const account = await exchangeCode(parsed.data.code, parsed.data.verifier, parsed.data.state);
        await claudeStore.write(account);
        return c.json({ connected: true, ...(account.scope !== undefined ? { scope: account.scope } : {}) });
    });

    app.get("/claude/account", async (c) => {
        const account = await claudeStore.read();
        return c.json({ connected: account !== undefined, ...(account?.scope !== undefined ? { scope: account.scope } : {}) });
    });

    app.post("/claude/account/disconnect", async (c) => {
        await claudeStore.clear();
        return c.json({ ok: true });
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

    // Past conversations in this workspace (the SDK-native session store, keyed on the workspace dir), for the
    // platform's chat history menu. List returns summaries; the :id route restores one transcript for display.
    app.get("/sessions", async (c) => c.json({ sessions: await sessions.list(workspace.root) }));

    app.get("/sessions/:id", async (c) => {
        try {
            return c.json({ messages: await sessions.read(workspace.root, c.req.param("id")) });
        } catch {
            return c.json({ error: "session not found" }, 404);
        }
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

    // The repo's tracked source tree — what the platform's source-control view renders.
    app.get("/git/:repo/files", async (c) => {
        const dir = repoDir(c.req.param("repo"));
        if (dir === undefined) {
            return c.json({ error: "unknown repo" }, 404);
        }
        return c.json({ files: await git.listFiles(dir) });
    });

    // Read one repo file (the platform reads deploy.config.ts here for inventory, and any file for the
    // source-control view). 400 when the path escapes the repo, 404 when the file is absent.
    app.get("/git/:repo/file", async (c) => {
        const dir = repoDir(c.req.param("repo"));
        if (dir === undefined) {
            return c.json({ error: "unknown repo" }, 404);
        }
        const path = c.req.query("path");
        const target = path === undefined ? undefined : resolveWithin(dir, path);
        if (target === undefined) {
            return c.json({ error: "invalid path" }, 400);
        }
        const content = await files.read(target);
        if (content === undefined) {
            return c.json({ error: "not found" }, 404);
        }
        return c.json({ path, content });
    });

    // Write one repo file (the platform rewrites deploy.config.ts after editing inventory). The platform then
    // commits via /git/:repo/commit — this route only touches the working tree, mirroring an agent edit.
    app.put("/git/:repo/file", async (c) => {
        const dir = repoDir(c.req.param("repo"));
        if (dir === undefined) {
            return c.json({ error: "unknown repo" }, 404);
        }
        const parsed = fileWriteBody.safeParse(await c.req.json().catch(() => undefined));
        if (!parsed.success) {
            return c.json({ error: "invalid body" }, 400);
        }
        const target = resolveWithin(dir, parsed.data.path);
        if (target === undefined) {
            return c.json({ error: "invalid path" }, 400);
        }
        await files.write(target, parsed.data.content);
        return c.json({ ok: true });
    });

    return app;
};
