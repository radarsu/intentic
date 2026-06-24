import type { Provider } from "@puristic/deploy-engine";
import type { ForgejoApi } from "@puristic/deploy-providers";
import { forgejoApi, parseInputs } from "@puristic/deploy-providers";
import { z } from "zod";

const controlRepoSchema = z.object({
    baseUrl: z.string(),
    owner: z.string(),
    name: z.string(),
    private: z.boolean(),
    adminUser: z.string(),
    adminPassword: z.string(),
});
type ControlRepoInputs = z.infer<typeof controlRepoSchema>;

const find = (api: ForgejoApi, parsed: ControlRepoInputs) =>
    api.findRepo({ baseUrl: parsed.baseUrl, user: parsed.adminUser, password: parsed.adminPassword, owner: parsed.owner, name: parsed.name });

// A repository in the control-plane Forgejo (the intent and reconciliation-target repos). read returns
// undefined while Forgejo is not yet up (its baseUrl ref is still PENDING) or unreachable, so a plan
// proceeds; apply create-or-skips. diff is a noop — a repo either exists or doesn't, and its contents
// live in commits, not reconciled config.
export const createControlRepoProvider = (api: ForgejoApi = forgejoApi): Provider => ({
    read: async (inputs, ctx) => {
        if (typeof inputs["baseUrl"] !== "string") {
            return undefined;
        }
        const parsed = parseInputs(controlRepoSchema, inputs, "control-repo");
        try {
            const repo = await find(api, parsed);
            if (repo === undefined) {
                return undefined;
            }
            return { outputs: { cloneUrl: repo.cloneUrl, sshUrl: repo.sshUrl } };
        } catch (error) {
            ctx.log(`control-repo "${ctx.id}": forgejo not reachable yet, treating as not-yet-created: ${String(error)}`);
            return undefined;
        }
    },
    diff: () => ({ action: "noop" }),
    apply: async (inputs) => {
        const parsed = parseInputs(controlRepoSchema, inputs, "control-repo");
        const existing = await find(api, parsed);
        const repo =
            existing ??
            (await api.createRepo({
                baseUrl: parsed.baseUrl,
                user: parsed.adminUser,
                password: parsed.adminPassword,
                owner: parsed.owner,
                name: parsed.name,
                private: parsed.private,
            }));
        return { cloneUrl: repo.cloneUrl, sshUrl: repo.sshUrl };
    },
});
