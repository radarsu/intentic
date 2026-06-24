import type { Provider, ResolvedInputs } from "@intentic/engine";
import { z } from "zod";
import { parseInputs } from "./inputs.js";
import type { KomodoApi } from "./komodo-api.js";
import { komodoApi } from "./komodo-api.js";

const appSchema = z.object({
    komodoUrl: z.string(),
    adminUser: z.string(),
    adminPassword: z.string(),
    repoName: z.string(),
    gitDomain: z.string(),
});
type AppInputs = z.infer<typeof appSchema>;
const parse = (inputs: ResolvedInputs): AppInputs => parseInputs(appSchema, inputs, "app");

// The Komodo Build that defines how the app's source repo is built into an image. Keyed by the app id
// (ctx.id), which is also the Forgejo repo name. The build's git source is the admin-owned repo on the
// platform's Forgejo, reached via Komodo's git provider for the git domain.
const buildConfig = (parsed: AppInputs): Record<string, unknown> => ({
    repo: `${parsed.adminUser}/${parsed.repoName}`,
    git_provider: parsed.gitDomain,
    git_account: parsed.adminUser,
});

// The app: a Komodo Build registering the source repo as a deployable image. No outputs (the per-env
// deployments reference it). read returns undefined until Komodo is up (komodoUrl PENDING) or unreachable.
export const createAppProvider = (api: KomodoApi = komodoApi): Provider => ({
    read: async (inputs, ctx) => {
        if (typeof inputs["komodoUrl"] !== "string") {
            return undefined;
        }
        const parsed = parse(inputs);
        try {
            const jwt = await api.login({ baseUrl: parsed.komodoUrl, username: parsed.adminUser, password: parsed.adminPassword });
            const build = (await api.listBuilds({ baseUrl: parsed.komodoUrl, jwt })).find((item) => item.name === ctx.id);
            if (build === undefined) {
                return undefined;
            }
            return { outputs: {} };
        } catch (error) {
            ctx.log(`app "${ctx.id}": komodo not reachable yet, treating as not-yet-created: ${String(error)}`);
            return undefined;
        }
    },
    diff: () => ({ action: "noop" }),
    apply: async (inputs, _observed, ctx) => {
        const parsed = parse(inputs);
        const jwt = await api.login({ baseUrl: parsed.komodoUrl, username: parsed.adminUser, password: parsed.adminPassword });
        const existing = (await api.listBuilds({ baseUrl: parsed.komodoUrl, jwt })).find((item) => item.name === ctx.id);
        if (existing === undefined) {
            await api.createBuild({ baseUrl: parsed.komodoUrl, jwt, name: ctx.id, config: buildConfig(parsed) });
        } else {
            await api.updateBuild({ baseUrl: parsed.komodoUrl, jwt, id: existing.id, config: buildConfig(parsed) });
        }
        return {};
    },
});
