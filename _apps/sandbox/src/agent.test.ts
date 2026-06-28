import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { expect, test } from "vitest";
import { type AgentEvent, type QueryFn, runAgent } from "./agent.js";

// Build a fake QueryFn yielding canned SDK messages (cast to SDKMessage — tests exercise only the fields
// runAgent reads), so the agent loop is verified without the SDK, a binary, or network.
const fakeQuery = (...messages: unknown[]): QueryFn =>
    async function* () {
        for (const message of messages) {
            yield message as SDKMessage;
        }
    };

const collect = async (request: Parameters<typeof runAgent>[0], queryFn: QueryFn): Promise<AgentEvent[]> => {
    const events: AgentEvent[] = [];
    for await (const event of runAgent(request, queryFn)) {
        events.push(event);
    }
    return events;
};

const request = { prompt: "add a /ping route", cwd: "/work", signal: new AbortController().signal };

test("a turn surfaces session, text deltas, tool actions, and a terminal done", async () => {
    const events = await collect(
        request,
        fakeQuery(
            { type: "system", subtype: "init", session_id: "sess-1" },
            { type: "stream_event", session_id: "sess-1", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Adding " } } },
            {
                type: "assistant",
                session_id: "sess-1",
                message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "src/app.ts" } }] },
            },
            { type: "assistant", session_id: "sess-1", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "pnpm test" } }] } },
            { type: "result", subtype: "success", result: "done" },
        ),
    );
    expect(events).toEqual([
        { kind: "session", sessionId: "sess-1" },
        { kind: "delta", text: "Adding " },
        { kind: "tool", name: "Edit", target: "src/app.ts" },
        { kind: "tool", name: "Bash", target: "pnpm test" },
        { kind: "done" },
    ]);
});

test("the per-turn oauth token is injected into the SDK options env, and stays absent when not given", async () => {
    let captured: Options | undefined;
    const capture: QueryFn = async function* (args) {
        captured = args.options;
        yield { type: "result", subtype: "success" } as SDKMessage;
    };

    await collect({ ...request, oauthToken: "tok-xyz" }, capture);
    expect(captured?.env?.["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("tok-xyz");

    captured = undefined;
    await collect(request, capture);
    expect(captured?.env).toBeUndefined();
});

test("a non-success result becomes an error followed by done", async () => {
    const events = await collect(request, fakeQuery({ type: "result", subtype: "error_max_turns", session_id: "s" }));
    expect(events).toEqual([
        { kind: "session", sessionId: "s" },
        { kind: "error", message: "agent did not complete (error_max_turns)" },
        { kind: "done" },
    ]);
});

test("a thrown error from the SDK is reported as an error event, then done", async () => {
    const throwing: QueryFn = async function* () {
        yield { type: "system", session_id: "s" } as SDKMessage;
        throw new Error("stream blew up");
    };
    expect(await collect(request, throwing)).toEqual([
        { kind: "session", sessionId: "s" },
        { kind: "error", message: "stream blew up" },
        { kind: "done" },
    ]);
});
