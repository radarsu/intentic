import type { CliConfig } from "@intentic/sandbox-contract";
import { join } from "node:path";
import type { CapabilityHandler } from "../capability.js";
import { cliProviders } from "../cli/providers.js";

// A CLI-tool integration: give the AGENT an authenticated command-line tool. `apply` drops the provider's
// SKILL.md cheatsheet into the workspace's .claude/skills/<id> (auto-loaded by the agent's settingSources); the
// credential itself is stored in the manifest config and injected into the agent's env each turn (see cliEnvOf),
// never written to a file. Distinct from `integration`, which wires a credential into DEPLOYED apps.
const skillPath = (root: string, id: string): string => join(root, ".claude", "skills", id, "SKILL.md");

export const cliHandler: CapabilityHandler = {
    apply: async function* (ctx, id, config) {
        const { provider } = config as CliConfig;
        await ctx.files.write(skillPath(ctx.workspace.root, id), cliProviders[provider].skill);
        yield { kind: "log", message: `Connected ${provider}. The agent can use it next turn via its skill + the credential in its env.` };
    },
    status: async (ctx, id) => ((await ctx.files.read(skillPath(ctx.workspace.root, id))) !== undefined ? { state: "active" } : { state: "inactive" }),
    remove: async (ctx, id) => {
        await ctx.files.remove(join(ctx.workspace.root, ".claude", "skills", id));
    },
};
