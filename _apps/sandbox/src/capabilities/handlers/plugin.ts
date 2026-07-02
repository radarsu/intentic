import { join } from "node:path";
import type { PluginConfig } from "@intentic/sandbox-contract";
import type { CapabilityHandler } from "../capability.js";
import { pluginDir, pluginsRoot } from "../plugin-dirs.js";

// Basic auth every major git host accepts for PATs (GitHub, GitLab). Rides -c http.extraheader (see gitClone),
// so the token never lands in the URL, .git/config, or the stderr the add route streams to the UI.
export const gitAuthHeader = (token: string): string => `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;

// A staging name that can never collide with a plugin dir: entry ids must start alphanumeric, this starts with
// a dot. Cloning lands here first so an agent turn never sees a half-cloned checkout under pluginDir.
const stagingName = (id: string): string => `.${id}.cloning`;

// A Claude Code plugin: the daemon owns the git checkout at .intentic/plugins/<id>; the Agent SDK's plugin
// loader reads its internals (skills/agents/hooks/commands/.mcp.json) each turn — see pluginDirsOf. Apply is an
// upsert: re-adding re-clones, which is also how a plugin updates. A pinned ref is checked out detached after a
// full clone (a shallow clone can't reach an arbitrary sha).
export const pluginHandler: CapabilityHandler = {
    apply: async function* (ctx, id, config) {
        const { url, ref, token } = config as PluginConfig;
        const root = pluginsRoot(ctx.workspace.root);
        const staging = join(root, stagingName(id));
        await ctx.files.mkdir(root);
        // A crashed earlier apply may have left a stale staging dir; clean slate before cloning.
        await ctx.files.remove(staging);
        yield { kind: "log", message: `Cloning ${url}${ref !== undefined ? ` @ ${ref}` : ""}…` };
        try {
            await ctx.git.clone(root, stagingName(id), url, undefined, token !== undefined ? gitAuthHeader(token) : undefined);
            if (ref !== undefined) {
                await ctx.git.checkout(staging, ref);
            }
        } catch (error) {
            // A failed clone/checkout leaves no debris; on an update the previous checkout stays active.
            await ctx.files.remove(staging);
            throw error;
        }
        await ctx.files.remove(pluginDir(ctx.workspace.root, id));
        await ctx.files.move(staging, pluginDir(ctx.workspace.root, id));
        yield { kind: "log", message: "Plugin installed — the agent loads its skills, agents and hooks next turn." };
    },
    // The short HEAD sha is the version identity — the daemon never parses plugin internals (plugin.json is
    // optional anyway). A missing/broken checkout probes as inactive; re-adding repairs it.
    status: async (ctx, id) => {
        try {
            return { state: "active", detail: await ctx.git.head(pluginDir(ctx.workspace.root, id)) };
        } catch {
            return { state: "inactive" };
        }
    },
    remove: async (ctx, id) => {
        await ctx.files.remove(pluginDir(ctx.workspace.root, id));
    },
};
