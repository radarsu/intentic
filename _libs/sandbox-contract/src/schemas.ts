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

// ---- workspace repos ----

export const ReposListSchema = z.object({ repos: z.array(z.string()) });
export const CloneRepoSchema = z.object({ name: z.string().min(1), cloneUrl: z.string().min(1), branch: z.string().optional() });
export const CloneResultSchema = z.object({ name: z.string(), path: z.string() });
// Scaffold the deployable app at /work/app: a zero-config starter, or adopt an existing repo via `cloneUrl`.
export const AppScaffoldSchema = z.object({ cloneUrl: z.string().url().optional() });

// ---- inventory: the i.have.* / i.want.service entries in deploy.config.ts's managed region ----
// The daemon renders/parses these; the browser edits them through the inventory routes. Moved here from the
// daemon's deploy-config.ts so the daemon and the browser validate against ONE schema (no cross-repo dupes).

export const InventoryProviderSchema = z.enum(["host", "cloudflare", "github", "stripe"]);
export type InventoryProvider = z.infer<typeof InventoryProviderSchema>;
export const ServiceKindSchema = z.enum(["signoz", "outline", "paperless", "openproject"]);
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

// A deploy-target host self-registering via the connect-host script's POST /enroll (connect-token auth). The SSH
// key (+ optional Cloudflare token) is written to desired-state/.env; the host (+ cf) is upserted into inventory.
export const EnrollHostInputSchema = z.object({
    name: inventoryName,
    user: z.string().min(1),
    address: z.string().min(1),
    port: z.coerce.number().default(22),
    via: z.enum(["direct", "cloudflared"]).default("cloudflared"),
    sshKey: z.string().min(1),
    cfToken: z.string().optional(),
});
export type EnrollHostInput = z.infer<typeof EnrollHostInputSchema>;

// ---- capabilities: the sandbox's unified capability manifest (.intentic/capabilities.json) ----
// Everything a user adds to a sandbox is a capability with an idempotent apply + a status check. The manifest is
// the source of truth for what's active; `mcp`-kind entries also feed the agent's MCP servers each turn. DevOps
// is the capability that scaffolds the intent/desired-state repos — until it's active the sandbox is empty.

export const CapabilityKindSchema = z.enum(["devops", "mcp", "service", "integration", "cli"]);
export type CapabilityKind = z.infer<typeof CapabilityKindSchema>;
export const CapabilityStateSchema = z.enum(["active", "pending", "error", "inactive"]);
export type CapabilityState = z.infer<typeof CapabilityStateSchema>;

// A manifest entry id (capabilities + automations) — also the `mcp__<id>__…` server name for mcp capabilities,
// so it's a safe identifier.
const entryId = z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);

// Per-kind config. Secrets (an mcp token) live here and are denylisted like tools.json.
export const McpConfigSchema = z.object({ url: z.string().url(), token: z.string().optional() });
export const ServiceConfigSchema = z.object({
    service: ServiceKindSchema,
    domain: z.string().min(1),
    on: z.string().min(1),
    expose: z.string().min(1),
});
// External-app credential injected into DEPLOYED apps (i.have.stripe → STRIPE_API_KEY from env). Agent-facing
// connectors are `cli` capabilities instead (see below), not integrations.
export const IntegrationConfigSchema = z.object({ provider: z.literal("stripe") });
// Per-provider CLI-tool config. A `cli` capability gives the AGENT an authenticated command-line tool (not a
// deployed-app credential like `integration`): the secret + any non-secret URL are stored here and injected
// into the agent's env each turn (see cliEnvOf), and a .claude/skills/<id> cheatsheet teaches the agent to use
// it via curl. Discriminated by provider so each provider's fields are typed and future providers slot in.
export const CliConfigSchema = z.discriminatedUnion("provider", [
    z.object({ provider: z.literal("discord"), botToken: z.string().min(1) }),
    z.object({ provider: z.literal("github"), token: z.string().min(1) }),
    z.object({ provider: z.literal("gitlab"), token: z.string().min(1), url: z.string().url() }),
    z.object({ provider: z.literal("sentry"), token: z.string().min(1), url: z.string().url(), org: z.string().optional() }),
    z.object({ provider: z.literal("redmine"), url: z.string().url(), apiKey: z.string().min(1) }),
    z.object({ provider: z.literal("outline"), url: z.string().url(), apiKey: z.string().min(1) }),
    z.object({ provider: z.literal("imap"), host: z.string().min(1), port: z.coerce.number(), username: z.string().min(1), password: z.string().min(1) }),
    z.object({ provider: z.literal("signoz"), url: z.string().url(), apiKey: z.string().min(1) }),
]);
export type McpConfig = z.infer<typeof McpConfigSchema>;
export type ServiceConfig = z.infer<typeof ServiceConfigSchema>;
export type IntegrationConfig = z.infer<typeof IntegrationConfigSchema>;
export type CliConfig = z.infer<typeof CliConfigSchema>;

export const CapabilitySchema = z.discriminatedUnion("kind", [
    z.object({ id: entryId, kind: z.literal("devops"), config: z.object({}) }),
    z.object({ id: entryId, kind: z.literal("mcp"), config: McpConfigSchema }),
    z.object({ id: entryId, kind: z.literal("service"), config: ServiceConfigSchema }),
    z.object({ id: entryId, kind: z.literal("integration"), config: IntegrationConfigSchema }),
    z.object({ id: entryId, kind: z.literal("cli"), config: CliConfigSchema }),
]);
export type Capability = z.infer<typeof CapabilitySchema>;

export const CapabilityStatusSchema = z.object({ state: CapabilityStateSchema, detail: z.string().optional() });
export type CapabilityStatus = z.infer<typeof CapabilityStatusSchema>;
// The list row: manifest entry + live status. Secrets are never returned (an mcp token becomes hasToken).
export const CapabilitySummarySchema = z.object({
    id: z.string(),
    kind: CapabilityKindSchema,
    status: CapabilityStatusSchema,
    config: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});
export const CapabilitiesListSchema = z.object({ capabilities: z.array(CapabilitySummarySchema) });
export const CapabilityIdParamSchema = z.object({ id: z.string() });

// ---- automations: scheduled agent wake-ups (.intentic/automations.json) ----
// An automation wakes the agent autonomously: the daemon's scheduler fires each enabled automation on its
// trigger, runs the optional guard command (a shell command in the workspace; non-zero exit skips the wake),
// then runs one agent turn with the prompt. The manifest is user config; run history is daemon-recorded.

// Discriminated on `kind` so an `event` trigger (webhook) can slot in later without a wire break.
export const TriggerSchema = z.discriminatedUnion("kind", [z.object({ kind: z.literal("schedule"), cron: z.string().min(1) })]);
export type Trigger = z.infer<typeof TriggerSchema>;

export const AutomationSchema = z.object({
    id: entryId,
    trigger: TriggerSchema,
    // Shell command run in the workspace root before waking; exit 0 ⇒ wake, non-zero ⇒ the run is "skipped".
    guard: z.string().min(1).optional(),
    prompt: z.string().min(1),
    enabled: z.boolean(),
});
export type Automation = z.infer<typeof AutomationSchema>;

export const AutomationRunSchema = z.object({
    at: z.number(),
    // skipped = the guard said no; error = the guard passed but the agent turn surfaced an error.
    outcome: z.enum(["completed", "skipped", "error"]),
    detail: z.string().optional(),
});
export type AutomationRun = z.infer<typeof AutomationRunSchema>;

// The list row: the stored automation + its recent runs + the next scheduled fire (absent when disabled).
export const AutomationSummarySchema = AutomationSchema.extend({
    runs: z.array(AutomationRunSchema),
    nextRun: z.number().optional(),
});
export const AutomationsListSchema = z.object({ automations: z.array(AutomationSummarySchema) });
export const AutomationIdParamSchema = z.object({ id: z.string() });

// ---- secrets: user-supplied env-var secrets the daemon writes to repositories/desired-state/.env ----
// The web posts a Cloudflare token / GitHub PAT / another-host SSH key straight to the sandbox daemon (never
// through the platform); `apply` reloads .env each run so a new secret is picked up with NO restart. `list`
// returns KEYS ONLY — the values never leave the sandbox.
export const SecretSetSchema = z.object({
    key: z
        .string()
        .regex(/^[A-Z][A-Z0-9_]*$/)
        .max(128),
    value: z.string().min(1),
});
export const SecretKeysSchema = z.object({ keys: z.array(z.string()) });

// ---- system ----

export const PreviewSchema = z.object({ running: z.boolean(), healthy: z.boolean(), port: z.number().optional() });
// The dev command's captured stdout+stderr tail + how it last ended — the UI's "App preview log" panel, so a
// failed `pnpm dev` (the `code: not found` that looked like a crash) is visible instead of buried in docker logs.
export const DevLogsSchema = z.object({
    output: z.string(),
    lastExit: z.object({ code: z.number().optional(), signal: z.string().optional() }).optional(),
});
export const InfoSchema = z.object({ name: z.string().optional(), image: z.string().optional() });
