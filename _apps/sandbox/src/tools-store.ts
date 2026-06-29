import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { type AgentTool, agentToolSchema } from "./tools.js";

// The sandbox-owned store of EXTERNAL agent tools (user-configured MCP integrations the platform manages by
// relay). Like the Claude credential store, the sandbox holds these — the platform persists nothing. Stored
// beside the workspace, outside the three repos, and on the secret denylist so the agent can't read the
// tokens via the file routes (it still uses them through MCP). Internal, intent-declared tools come from env
// instead (INTENTIC_AGENT_TOOLS) and are not stored here.
export interface ToolsStore {
    readonly list: () => Promise<AgentTool[]>;
    // Upsert by name (re-adding the same name edits its url/token) so a tool's MCP server name stays unique.
    readonly add: (tool: AgentTool) => Promise<void>;
    // True when a tool of that name existed and was removed.
    readonly remove: (name: string) => Promise<boolean>;
}

// A JSON file store, used in production at <workspace>/.intentic/tools.json.
export const fileToolsStore = (path: string): ToolsStore => {
    const read = async (): Promise<AgentTool[]> => {
        try {
            const parsed = z.array(agentToolSchema).safeParse(JSON.parse(await readFile(path, "utf8")));
            return parsed.success ? parsed.data : [];
        } catch {
            return [];
        }
    };
    const write = async (tools: AgentTool[]): Promise<void> => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, `${JSON.stringify(tools, undefined, 2)}\n`);
    };
    return {
        list: read,
        add: async (tool) => {
            await write([...(await read()).filter((existing) => existing.name !== tool.name), tool]);
        },
        remove: async (name) => {
            const tools = await read();
            const next = tools.filter((tool) => tool.name !== name);
            if (next.length === tools.length) {
                return false;
            }
            await write(next);
            return true;
        },
    };
};
