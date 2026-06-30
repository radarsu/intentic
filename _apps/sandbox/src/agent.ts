import {
    createSdkMcpServer,
    type EffortLevel,
    type Options,
    type PermissionMode,
    query,
    type SDKMessage,
    tool,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent, AskQuestion } from "@intentic/sandbox-contract";
import { z } from "zod";
import { createPlanRequest, createQuestionRequest, type QuestionResponse } from "./agent-requests.js";
import { type AgentTool, mcpServersOf } from "./tools.js";

export interface AgentRequest {
    readonly prompt: string;
    // The working dir the agent edits — the workspace root, so it can touch all three repos.
    readonly cwd: string;
    // Resume a prior turn's session for multi-message conversations.
    readonly sessionId?: string;
    readonly signal: AbortSignal;
    // Defaults to the account/subscription default; override with INTENTIC_AGENT_MODEL.
    readonly model?: string;
    // The user's Claude subscription token, injected into the SDK for this turn. Resolved by the daemon from
    // the sandbox's own stored credentials (the platform no longer relays it); undefined falls back to the
    // container's ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN env.
    readonly oauthToken?: string;
    // Defaults to the autonomous sandbox posture; the container's isolation is what makes this safe.
    readonly permissionMode?: PermissionMode;
    // When true, run the always-plan flow: propose an approach via ExitPlanMode and wait for approval
    // before executing (tools then auto-accept). Clarifying questions are asked via AskUserQuestion.
    readonly plan?: boolean;
    // Reasoning controls forwarded to the SDK (effort level / extended thinking).
    readonly effort?: string;
    readonly thinking?: boolean;
    // The agent's MCP tools for this turn: intent-declared internal services (set in this container's env) plus
    // platform-configured external integrations. Each becomes a remote `http` MCP server. The daemon merges
    // both sources before calling; absent ⇒ the agent runs with no MCP tools (its plain autonomous posture).
    readonly tools?: readonly AgentTool[];
}

// The SDK `query` is injected so tests drive a fake message stream — no API calls, no bundled binary.
export type QueryFn = (args: { readonly prompt: string; readonly options: Options }) => AsyncIterable<SDKMessage>;
const defaultQuery: QueryFn = (args) => query(args);

// The file path (Read/Write/Edit) or command (Bash) a tool acts on, for the `tool` event's target.
const toolTarget = (input: unknown): string | undefined => {
    if (typeof input !== "object" || input === null) {
        return undefined;
    }
    const record = input as Record<string, unknown>;
    const path = record["file_path"];
    if (typeof path === "string") {
        return path;
    }
    const command = record["command"];
    return typeof command === "string" ? command : undefined;
};

// Map the SDK message stream onto AgentEvents (session / delta / tool / error). Shared by the plain and
// plan paths; does NOT emit the terminal `done` (callers do that once the whole turn settles).
async function* streamSdk(queryFn: QueryFn, prompt: string, options: Options): AsyncGenerator<AgentEvent> {
    let sessionSent = false;
    for await (const message of queryFn({ prompt, options })) {
        const sessionId = (message as { session_id?: string }).session_id;
        if (!sessionSent && typeof sessionId === "string" && sessionId !== "") {
            sessionSent = true;
            yield { kind: "session", sessionId };
        }

        if (message.type === "stream_event") {
            const event = message.event as { type: string; delta?: { type: string; text?: string } };
            if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && typeof event.delta.text === "string") {
                yield { kind: "delta", text: event.delta.text };
            }
        } else if (message.type === "assistant") {
            if (message.error !== undefined) {
                yield { kind: "error", message: `agent error: ${message.error}` };
            } else {
                const content = message.message.content as ReadonlyArray<{ type: string; name?: string; input?: unknown }>;
                for (const block of content) {
                    if (block.type === "tool_use" && typeof block.name === "string") {
                        const target = toolTarget(block.input);
                        yield target !== undefined ? { kind: "tool", name: block.name, target } : { kind: "tool", name: block.name };
                    }
                }
            }
        } else if (message.type === "result") {
            if (message.subtype !== "success") {
                yield { kind: "error", message: `agent did not complete (${message.subtype})` };
            }
            return;
        }
    }
}

// Render the user's question picks (or a dismissal) as the `ask` tool's text result.
const formatAnswers = (questions: AskQuestion[], response: QuestionResponse): string => {
    if (response.cancelled || response.answers === undefined) {
        return "The user dismissed the questions without answering. Proceed with sensible defaults unless essential.";
    }
    const answers = response.answers;
    const lines = questions.map((q) => {
        const picks = answers[q.question] ?? [];
        return `- ${q.header || q.question}: ${picks.length > 0 ? picks.join(", ") : "(no answer)"}`;
    });
    return `The user answered:\n${lines.join("\n")}`;
};

// Cap the stderr tail folded into an error message so a chatty failure can't flood the UI.
const STDERR_TAIL = 2000;

// Fold the Claude Code subprocess's stderr tail into the surfaced error, so a bare "exited with code 1"
// becomes the actual reason. Without this the SDK's terminal error is opaque (this is how the
// root/`--dangerously-skip-permissions` failure was found).
const errorMessage = (error: unknown, stderr: string): string => {
    const base = error instanceof Error ? error.message : "agent failed";
    const detail = stderr.trim().slice(-STDERR_TAIL);
    return detail ? `${base}: ${detail}` : base;
};

// Base SDK options shared by both paths.
const baseOptions = (request: AgentRequest, abortController: AbortController, permissionMode: PermissionMode): Options => ({
    cwd: request.cwd,
    includePartialMessages: true,
    permissionMode,
    abortController,
    env: {
        ...process.env,
        // We run with --dangerously-skip-permissions (bypassPermissions) because the container IS the
        // isolation boundary. Claude Code refuses that flag under root (the sandbox runs as root) unless
        // IS_SANDBOX marks the environment as already-sandboxed — which this container is.
        IS_SANDBOX: "1",
        ...(request.oauthToken !== undefined ? { CLAUDE_CODE_OAUTH_TOKEN: request.oauthToken } : {}),
    },
    ...(request.model !== undefined ? { model: request.model } : {}),
    ...(request.sessionId !== undefined ? { resume: request.sessionId } : {}),
    ...(request.effort !== undefined ? { effort: request.effort as EffortLevel } : {}),
    ...(request.thinking !== undefined ? { thinking: request.thinking ? { type: "adaptive" } : { type: "disabled" } } : {}),
});

// Run one agent turn over `request.cwd`, streaming typed events. A throwing/aborted turn surfaces as an
// `error` event (errors are reported to the UI, not swallowed, then the stream closes with `done`).
export async function* runAgent(request: AgentRequest, queryFn: QueryFn = defaultQuery): AsyncGenerator<AgentEvent> {
    const abortController = new AbortController();
    if (request.signal.aborted) {
        abortController.abort();
    } else {
        request.signal.addEventListener("abort", () => abortController.abort(), { once: true });
    }

    if (request.plan === true) {
        yield* runPlanTurn(request, queryFn, abortController);
        return;
    }

    // Default autonomous posture: full tools, no prompting. The container's isolation makes this safe.
    const permissionMode: PermissionMode = request.permissionMode ?? "bypassPermissions";
    const mcpServers = mcpServersOf(request.tools ?? []);
    let stderr = "";
    const options: Options = {
        ...baseOptions(request, abortController, permissionMode),
        allowDangerouslySkipPermissions: permissionMode === "bypassPermissions",
        stderr: (data) => {
            stderr += data;
        },
        ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
    };
    try {
        yield* streamSdk(queryFn, request.prompt, options);
    } catch (error) {
        yield { kind: "error", message: errorMessage(error, stderr) };
    }
    yield { kind: "done" };
}

// Always-plan flow: the model proposes via ExitPlanMode (we surface a `plan` event and block on the user's
// approval), asks clarifying questions via AskUserQuestion (aliased to our `ask` tool → `question` event),
// and once approved executes with every tool auto-accepted. `canUseTool` runs concurrently with the SDK
// loop, so a queue bridges both into this generator.
async function* runPlanTurn(request: AgentRequest, queryFn: QueryFn, abortController: AbortController): AsyncGenerator<AgentEvent> {
    const queue: AgentEvent[] = [];
    let wake: () => void = () => {};
    let finished = false;
    const push = (event: AgentEvent): void => {
        queue.push(event);
        wake();
    };

    const uiServer = createSdkMcpServer({
        name: "ui",
        tools: [
            tool(
                "ask",
                'Ask the user 1-4 clarifying multiple-choice questions and wait for their answers. Use this whenever you need the user to choose between options before proceeding. Each question has 2-4 options; do NOT add an "Other" option — a free-text choice is provided automatically. Set multiSelect when several options may be picked together.',
                {
                    questions: z
                        .array(
                            z.object({
                                question: z.string(),
                                header: z.string(),
                                multiSelect: z.boolean(),
                                options: z
                                    .array(z.object({ label: z.string(), description: z.string(), preview: z.string().optional() }))
                                    .min(2)
                                    .max(4),
                            }),
                        )
                        .min(1)
                        .max(4),
                },
                async (args) => {
                    const { id, wait } = createQuestionRequest();
                    push({ kind: "question", requestId: id, questions: args.questions as AskQuestion[] });
                    const response = await wait(request.signal);
                    return { content: [{ type: "text", text: formatAnswers(args.questions as AskQuestion[], response) }] };
                },
            ),
        ],
    });

    let stderr = "";
    const options: Options = {
        ...baseOptions(request, abortController, "plan"),
        stderr: (data) => {
            stderr += data;
        },
        // The `ui` server backs AskUserQuestion; the agent's remote MCP tools are merged in alongside it so
        // the model can also consult them while planning (a same-named tool would override `ui`, but `ui` is
        // reserved). canUseTool auto-allows every tool after approval, so the remote tools need no extra gate.
        mcpServers: { ui: uiServer, ...mcpServersOf(request.tools ?? []) },
        toolAliases: { AskUserQuestion: "mcp__ui__ask" },
        planModeInstructions:
            "Propose a clear, concise approach for the user's request, then call ExitPlanMode to ask for approval before executing. When you need the user to choose between options, ask with the AskUserQuestion tool rather than writing the choices as plain text.",
        canUseTool: async (toolName, input) => {
            if (toolName === "ExitPlanMode") {
                const { id, wait } = createPlanRequest();
                push({ kind: "plan", decisionId: id, text: String((input as { plan?: unknown }).plan ?? "") });
                const decision = await wait(request.signal);
                if (decision.approve) {
                    return { behavior: "allow", updatedInput: input };
                }
                return { behavior: "deny", message: decision.feedback?.trim() || "Keep refining the plan — do not exit plan mode yet." };
            }
            // After approval (and for question prompts) every tool is auto-accepted — the container is the
            // isolation boundary, so execution needs no per-command prompting.
            return { behavior: "allow", updatedInput: input };
        },
    };

    const pump = (async () => {
        try {
            for await (const event of streamSdk(queryFn, request.prompt, options)) {
                push(event);
            }
        } catch (error) {
            push({ kind: "error", message: errorMessage(error, stderr) });
        } finally {
            finished = true;
            wake();
        }
    })();

    try {
        for (;;) {
            if (queue.length > 0) {
                yield queue.shift() as AgentEvent;
                continue;
            }
            if (finished) {
                break;
            }
            await new Promise<void>((resolve) => {
                wake = resolve;
            });
            wake = () => {};
        }
    } finally {
        await pump;
    }
    yield { kind: "done" };
}
