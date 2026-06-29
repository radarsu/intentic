import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

// One agent tool: a remote MCP endpoint reached by URL with an optional scoped bearer token. Two sources feed
// this, both shaped identically: intent-declared INTERNAL tools arrive base64-encoded in INTENTIC_AGENT_TOOLS
// (the workspace provider forwards them through the runner), and platform-configured EXTERNAL tools arrive per
// turn in the agent request body. Both become remote `http` MCP servers on the Claude Agent SDK.
export const agentToolSchema = z.object({
    // The MCP server name; surfaces to the model as `mcp__<name>__<tool>`. Service id for internal tools.
    name: z.string().min(1),
    url: z.string().url(),
    // The scoped bearer sent as `Authorization: Bearer <token>`. Absent for unauthenticated endpoints.
    token: z.string().optional(),
});
export type AgentTool = z.infer<typeof agentToolSchema>;

// A valid MCP server name: surfaces to the model as `mcp__<name>__<tool>`, so keep it to a safe identifier
// (alphanumeric start, then alphanumerics / `_` / `-`). Guards the external-tools route.
export const isValidToolName = (name: string): boolean => /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name);

// Decode the runner-injected internal tools. The provider base64-encodes the JSON so braces/quotes ride the
// `docker -e` value cleanly; absent/empty ⇒ no internal tools. A malformed value throws (a provisioning bug).
export const internalTools = (encoded: string | undefined): AgentTool[] => {
    if (encoded === undefined || encoded === "") {
        return [];
    }
    const json = Buffer.from(encoded, "base64").toString("utf8");
    return z.array(agentToolSchema).parse(JSON.parse(json));
};

// Build the SDK `mcpServers` map from a tool list. Tools are `alwaysLoad` so a small, curated set stays
// present in the prompt instead of being deferred behind tool search — best agent performance for known tools.
// A later entry with the same name wins (lets external config override an internal default).
export const mcpServersOf = (tools: readonly AgentTool[]): Record<string, McpServerConfig> => {
    const servers: Record<string, McpServerConfig> = {};
    for (const tool of tools) {
        servers[tool.name] = {
            type: "http",
            url: tool.url,
            alwaysLoad: true,
            ...(tool.token !== undefined ? { headers: { Authorization: `Bearer ${tool.token}` } } : {}),
        };
    }
    return servers;
};
