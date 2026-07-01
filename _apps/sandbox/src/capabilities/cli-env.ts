import type { Capability } from "@intentic/sandbox-contract";
import { cliProviders } from "./cli/providers.js";

// The env vars the agent's shell needs for its connected CLI tools, derived from cli-kind capabilities each
// turn — the parallel to mcpToolsOf for the CLI path. Merged into the agent SDK's `env` (see agent.ts), so a
// `bash` command like `curl -H "Authorization: Bot $DISCORD_BOT_TOKEN" …` reads the user's stored credential.
export const cliEnvOf = (capabilities: readonly Capability[]): Record<string, string> => {
    const env: Record<string, string> = {};
    for (const capability of capabilities) {
        if (capability.kind === "cli") {
            Object.assign(env, cliProviders[capability.config.provider].env(capability.config));
        }
    }
    return env;
};
