import { type Options, type PermissionMode, query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

// One frame from an agent turn, relayed to the UI. `kind`-discriminated to match intentic's event style
// (EngineEvent, IntenticLine); the platform relay maps these to the browser's `type` shape. `tool` surfaces
// agent actions ("editing <file>" / "running <command>") so the UI shows what the agent is doing.
export type AgentEvent =
    | { readonly kind: "session"; readonly sessionId: string }
    | { readonly kind: "delta"; readonly text: string }
    | { readonly kind: "tool"; readonly name: string; readonly target?: string }
    | { readonly kind: "error"; readonly message: string }
    | { readonly kind: "done" };

export interface AgentRequest {
    readonly prompt: string;
    // The working dir the agent edits — the workspace root, so it can touch all three repos.
    readonly cwd: string;
    // Resume a prior turn's session for multi-message conversations.
    readonly sessionId?: string;
    readonly signal: AbortSignal;
    // Defaults to the account/subscription default; override with INTENTIC_AGENT_MODEL.
    readonly model?: string;
    // Defaults to the autonomous sandbox posture; the container's isolation is what makes this safe.
    readonly permissionMode?: PermissionMode;
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

// Run one agent turn over `request.cwd`, streaming typed events. A throwing/aborted turn surfaces as an
// `error` event (errors are reported to the UI, not swallowed, then the stream closes with `done`).
export async function* runAgent(request: AgentRequest, queryFn: QueryFn = defaultQuery): AsyncGenerator<AgentEvent> {
    const abortController = new AbortController();
    if (request.signal.aborted) {
        abortController.abort();
    } else {
        request.signal.addEventListener("abort", () => abortController.abort(), { once: true });
    }

    const permissionMode: PermissionMode = request.permissionMode ?? "bypassPermissions";
    const options: Options = {
        cwd: request.cwd,
        includePartialMessages: true,
        permissionMode,
        allowDangerouslySkipPermissions: permissionMode === "bypassPermissions",
        abortController,
        ...(request.model !== undefined ? { model: request.model } : {}),
        ...(request.sessionId !== undefined ? { resume: request.sessionId } : {}),
    };

    let sessionSent = false;
    try {
        for await (const message of queryFn({ prompt: request.prompt, options })) {
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
                break;
            }
        }
    } catch (error) {
        yield { kind: "error", message: error instanceof Error ? error.message : "agent failed" };
    }
    yield { kind: "done" };
}
