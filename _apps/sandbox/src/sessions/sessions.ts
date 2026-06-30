import { getSessionMessages, listSessions } from "@anthropic-ai/claude-agent-sdk";

// A past conversation in this workspace, for the platform's chat-history list. `title` is the SDK's
// resolved display summary (custom title / auto-summary / first prompt); `updatedAt` is its last-modified ms.
export interface SessionSummary {
    readonly id: string;
    readonly title: string;
    readonly updatedAt: number;
}

// One restored transcript turn — text only (tool/thinking blocks are dropped; live turns still stream those).
export interface SessionTranscriptMessage {
    readonly role: "user" | "assistant";
    readonly text: string;
}

// The `message` field of a stored turn is an Anthropic message: content is a string or a block array.
interface AnthropicMessageLike {
    content?: string | Array<{ type?: string; text?: string }>;
}

// List the workspace's past Claude sessions (newest first, capped) for the history menu. Sessions are
// persisted by the SDK keyed on the working dir, so passing the workspace root scopes them to this sandbox.
export const listWorkspaceSessions = async (dir: string): Promise<SessionSummary[]> => {
    const sessions = await listSessions({ dir, limit: 50 });
    return sessions.map((session) => ({
        id: session.sessionId,
        title: session.customTitle ?? session.summary ?? session.firstPrompt ?? "New chat",
        updatedAt: session.lastModified,
    }));
};

// Flatten one session into a {role, text} transcript for restoring a chat from history before resuming it.
export const readWorkspaceSession = async (dir: string, id: string): Promise<SessionTranscriptMessage[]> => {
    const messages = await getSessionMessages(id, { dir });
    const out: SessionTranscriptMessage[] = [];
    for (const message of messages) {
        if (message.type !== "user" && message.type !== "assistant") {
            continue;
        }
        const content = (message.message as AnthropicMessageLike | undefined)?.content;
        const text =
            typeof content === "string"
                ? content
                : (content ?? [])
                      .filter((block) => block.type === "text" && typeof block.text === "string")
                      .map((block) => block.text)
                      .join("");
        if (text.length > 0) {
            out.push({ role: message.type, text });
        }
    }
    return out;
};
