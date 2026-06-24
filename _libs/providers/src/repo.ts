import type { Provider, ResolvedInputs } from "@intentic/engine";
import { z } from "zod";
import type { ForgejoApi } from "./forgejo-api.js";
import { forgejoApi } from "./forgejo-api.js";
import { parseInputs } from "./inputs.js";

const repoSchema = z.object({
    name: z.string(),
    private: z.boolean(),
    forgejoUrl: z.string(),
    domain: z.string(),
    adminUser: z.string(),
    adminPassword: z.string(),
});
type RepoInputs = z.infer<typeof repoSchema>;
const parse = (inputs: ResolvedInputs): RepoInputs => parseInputs(repoSchema, inputs, "repo");

// The clone/ssh urls are re-derived deterministically from the git domain + admin owner + repo name, so a
// healthy noop produces a stable output set without depending on how Forgejo formats them.
const outputsFor = (parsed: RepoInputs): Record<string, unknown> => ({
    cloneUrl: `https://${parsed.domain}/${parsed.adminUser}/${parsed.name}.git`,
    sshUrl: `git@${parsed.domain}:${parsed.adminUser}/${parsed.name}.git`,
});

// The app's source repository, created under the Forgejo admin user. read returns undefined when Forgejo
// is not yet up (its url input is still PENDING) or unreachable, so a plan proceeds; apply create-or-skips.
export const createRepoProvider = (api: ForgejoApi = forgejoApi): Provider => ({
    read: async (inputs, ctx) => {
        if (typeof inputs["forgejoUrl"] !== "string") {
            return undefined;
        }
        const parsed = parse(inputs);
        try {
            const repo = await api.findRepo({
                baseUrl: parsed.forgejoUrl,
                user: parsed.adminUser,
                password: parsed.adminPassword,
                owner: parsed.adminUser,
                name: parsed.name,
            });
            if (repo === undefined) {
                return undefined;
            }
            return { outputs: outputsFor(parsed) };
        } catch (error) {
            ctx.log(`repo "${ctx.id}": forgejo not reachable yet, treating as not-yet-created: ${String(error)}`);
            return undefined;
        }
    },
    diff: () => ({ action: "noop" }),
    apply: async (inputs) => {
        const parsed = parse(inputs);
        const existing = await api.findRepo({
            baseUrl: parsed.forgejoUrl,
            user: parsed.adminUser,
            password: parsed.adminPassword,
            owner: parsed.adminUser,
            name: parsed.name,
        });
        if (existing === undefined) {
            await api.createRepo({
                baseUrl: parsed.forgejoUrl,
                user: parsed.adminUser,
                password: parsed.adminPassword,
                owner: parsed.adminUser,
                name: parsed.name,
                private: parsed.private,
            });
        }
        return outputsFor(parsed);
    },
});
