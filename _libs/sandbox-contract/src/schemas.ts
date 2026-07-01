import { z } from "zod";

// All request/response wire schemas for the sandbox daemon. Inputs that carry a `{param}` in their route path
// (repo / id / name) merge the path param into the same flat object — oRPC fills the path placeholder from the
// matching key and routes the rest to the body (POST/PUT) or query (GET).

// ---- shared ----

// Success ack for routes that only report completion (push / disconnect / self-host register). A turn paused on
// a plan/question that no longer exists, or a missing repo/path, is an ORPCError thrown by the handler instead.
export const OkSchema = z.object({ ok: z.literal(true) });

// The three workspace repos, by role. Kept as a bare string on the wire (not an enum) so an unknown repo is a
// handler-thrown NOT_FOUND — matching the daemon's prior 404 — rather than an input-validation rejection.
export const RepoParamSchema = z.object({ repo: z.string() });

// ---- agent ----

export const AgentTurnSchema = z.object({
    prompt: z.string().min(1),
    sessionId: z.string().optional(),
    // The browser sends the chosen model per turn; the Claude token is the sandbox's own stored credential.
    model: z.string().optional(),
    // When true, run the always-plan flow (propose → approve → execute). Reasoning controls are optional.
    plan: z.boolean().optional(),
    effort: z.string().optional(),
    thinking: z.boolean().optional(),
});
export type AgentTurn = z.infer<typeof AgentTurnSchema>;

// Side-channel bodies: the UI posts these to resolve a turn paused on a plan approval / question.
export const DecisionSchema = z.object({ decisionId: z.string().min(1), approve: z.boolean(), feedback: z.string().optional() });
export const AnswerSchema = z.object({
    requestId: z.string().min(1),
    answers: z.record(z.string(), z.array(z.string())).optional(),
    cancelled: z.boolean().optional(),
});

// ---- claude oauth ----

export const ClaudeExchangeSchema = z.object({ code: z.string().min(1), verifier: z.string().min(1), state: z.string().min(1) });
export const AuthorizeChallengeSchema = z.object({ authorizeUrl: z.string(), verifier: z.string(), state: z.string() });
export const ClaudeAccountSchema = z.object({ connected: z.boolean(), scope: z.string().optional() });

// ---- sessions ----

export const SessionIdParamSchema = z.object({ id: z.string() });
export const SessionSummarySchema = z.object({ id: z.string(), title: z.string(), updatedAt: z.number() });
export const SessionsListSchema = z.object({ sessions: z.array(SessionSummarySchema) });
export const SessionTranscriptMessageSchema = z.object({ role: z.enum(["user", "assistant"]), text: z.string() });
export const SessionTranscriptSchema = z.object({ messages: z.array(SessionTranscriptMessageSchema) });

// ---- intentic CLI ----

export const IntenticRunSchema = z.object({ args: z.array(z.string()) });

// ---- git ----

export const CommitSchema = RepoParamSchema.extend({ message: z.string().min(1) });
export const PushSchema = RepoParamSchema.extend({ branch: z.string().min(1) });
export const GitFileQuerySchema = RepoParamSchema.extend({ path: z.string().min(1) });
export const GitFileWriteSchema = RepoParamSchema.extend({ path: z.string().min(1), content: z.string() });
export const GitStatusSchema = z.object({ branch: z.string(), dirty: z.boolean(), files: z.array(z.string()) });
export const GitFilesSchema = z.object({ files: z.array(z.string()) });
export const GitFileSchema = z.object({ path: z.string(), content: z.string() });
export const CommitResultSchema = z.object({ committed: z.boolean() });

// ---- workspace tree + files ----

// One node of the full /work filesystem tree the agent sees (untracked + generated files included), distinct
// from the git-tracked listing. `path` is root-relative with forward slashes so it feeds straight back to the
// file route. Recursive via zod's getter form (so the type is inferred, not hand-annotated).
export const WorkspaceTreeEntrySchema = z.object({
    name: z.string(),
    path: z.string(),
    type: z.enum(["file", "dir"]),
    size: z.number().optional(),
    get children() {
        return z.array(WorkspaceTreeEntrySchema).optional();
    },
});
export type WorkspaceTreeEntry = z.infer<typeof WorkspaceTreeEntrySchema>;
export const WorkspaceTreeSchema = z.object({
    root: z.string(),
    tree: z.array(WorkspaceTreeEntrySchema),
    // True when the walk hit the depth/entry cap and the returned tree is partial.
    truncated: z.boolean(),
});
export type WorkspaceTree = z.infer<typeof WorkspaceTreeSchema>;
export const WorkspaceFileQuerySchema = z.object({ path: z.string().min(1) });
export const WorkspaceFileSchema = z.object({ path: z.string(), content: z.string() });
// Direct file management over the /work tree (delete / new folder / rename+move / copy). Byte writes + the
// editor's text save go through the plain POST /workspace/upload route (a body doesn't fit oRPC), not here.
export const WorkspaceDirSchema = z.object({ path: z.string().min(1) });
export const WorkspaceMoveSchema = z.object({ from: z.string().min(1), to: z.string().min(1) });

// ---- workspace repos + external tools ----

export const ReposListSchema = z.object({ repos: z.array(z.string()) });
export const CloneRepoSchema = z.object({ name: z.string().min(1), cloneUrl: z.string().min(1), branch: z.string().optional() });
export const CloneResultSchema = z.object({ name: z.string(), path: z.string() });
// Scaffold the deployable app at /work/app: a zero-config starter, or adopt an existing repo via `cloneUrl`.
export const AppScaffoldSchema = z.object({ cloneUrl: z.string().url().optional() });
// Add/edit an external MCP tool. `name` is validated more strictly in the handler (isValidToolName).
export const ToolInputSchema = z.object({ name: z.string().min(1), url: z.string().url(), token: z.string().optional() });
// The list never returns the token (it stays in the sandbox) — only its presence.
export const ToolSummarySchema = z.object({ name: z.string(), url: z.string(), hasToken: z.boolean() });
export const ToolsListSchema = z.object({ tools: z.array(ToolSummarySchema) });
export const ToolAddResultSchema = z.object({ name: z.string() });
export const ToolNameParamSchema = z.object({ name: z.string() });

// ---- inventory: the i.have.* / i.want.service entries in deploy.config.ts's managed region ----
// The daemon renders/parses these; the browser edits them through the inventory routes. Moved here from the
// daemon's deploy-config.ts so the daemon and the browser validate against ONE schema (no cross-repo dupes).

export const InventoryProviderSchema = z.enum(["host", "cloudflare", "github", "stripe"]);
export type InventoryProvider = z.infer<typeof InventoryProviderSchema>;
export const ServiceKindSchema = z.enum(["signoz"]);
export type ServiceKind = z.infer<typeof ServiceKindSchema>;
// Non-secret option values the user provides; secret options (sshKey, apiToken, apiKey) are emitted as env()
// references and never travel over the wire.
export const InventoryValuesSchema = z.record(z.string(), z.union([z.string(), z.number()]));
// `const <name>` binding in deploy.config.ts, so it must be a valid identifier.
const inventoryName = z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/);
export const BackendEntrySchema = z.object({
    kind: z.literal("backend"),
    provider: InventoryProviderSchema,
    name: z.string(),
    values: InventoryValuesSchema,
});
export const ServiceEntrySchema = z.object({
    kind: z.literal("service"),
    service: ServiceKindSchema,
    name: z.string(),
    values: InventoryValuesSchema,
    on: z.string(),
    expose: z.string(),
});
export const InventoryEntrySchema = z.discriminatedUnion("kind", [BackendEntrySchema, ServiceEntrySchema]);
export type InventoryEntry = z.infer<typeof InventoryEntrySchema>;
export const AddInventoryInputSchema = z.discriminatedUnion("kind", [
    BackendEntrySchema.extend({ name: inventoryName }),
    ServiceEntrySchema.extend({ name: inventoryName }),
]);
export type AddInventoryInput = z.infer<typeof AddInventoryInputSchema>;
export const InventoryNameParamSchema = z.object({ name: z.string() });
export const InventoryListSchema = z.object({ entries: z.array(InventoryEntrySchema) });

// ---- system ----

export const PreviewSchema = z.object({ running: z.boolean(), healthy: z.boolean(), port: z.number().optional() });
// The dev command's captured stdout+stderr tail + how it last ended — the UI's "App preview log" panel, so a
// failed `pnpm dev` (the `code: not found` that looked like a crash) is visible instead of buried in docker logs.
export const DevLogsSchema = z.object({
    output: z.string(),
    lastExit: z.object({ code: z.number().optional(), signal: z.string().optional() }).optional(),
});
export const SelfHostSchema = z.object({ user: z.string(), address: z.string(), port: z.number(), via: z.enum(["direct", "cloudflared"]) });
export type SelfHost = z.infer<typeof SelfHostSchema>;
export const SelfHostResponseSchema = z.object({ selfHost: SelfHostSchema.nullable() });
export const InfoSchema = z.object({ name: z.string().optional(), image: z.string().optional() });
