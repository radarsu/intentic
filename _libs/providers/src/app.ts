import type { Provider, ResolvedInputs } from "@intentic/engine";
import { z } from "zod";
import { gitProvider, parseInputs } from "./inputs.js";
import type { KomodoApi } from "./komodo-api.js";
import { komodoApi } from "./komodo-api.js";

const appSchema = z.object({
    komodoUrl: z.string(),
    adminUser: z.string(),
    adminPassword: z.string(),
    repoName: z.string(),
    // The INTERNAL Forgejo url (http://<internalIp>:3000) Komodo clones the repo from; see gitProvider/komodo.ts.
    gitInternalUrl: z.string(),
});
type AppInputs = z.infer<typeof appSchema>;
const parse = (inputs: ResolvedInputs): AppInputs => parseInputs(appSchema, inputs, "app");

// The Komodo server + Server builder Komodo auto-registers from KOMODO_FIRST_SERVER_* (both named "Local").
// Every Build needs a builder attached or RunBuild fails; we reuse the auto-created "Local" builder, creating
// it only if it is somehow absent.
const SERVER = "Local";
const BUILDER = "Local";

// The Komodo Build that defines how the app's source repo is built into an image. Keyed by the app id
// (ctx.id), which is also the Forgejo repo name. The build's git source is the admin-owned repo on the
// platform's Forgejo, reached via Komodo's git provider for the git domain, built on the local Server builder.
const buildConfig = (parsed: AppInputs, builderId: string): Record<string, unknown> => {
    const git = gitProvider(parsed.gitInternalUrl);
    return {
        builder_id: builderId,
        repo: `${parsed.adminUser}/${parsed.repoName}`,
        git_provider: git.domain,
        git_account: parsed.adminUser,
        git_https: git.https,
    };
};

// Ensure the shared Server builder exists and return its id (the build references it by id).
const ensureBuilder = async (api: KomodoApi, baseUrl: string, jwt: string): Promise<string> => {
    const find = async (): Promise<string | undefined> => (await api.listBuilders({ baseUrl, jwt })).find((item) => item.name === BUILDER)?.id;
    const existing = await find();
    if (existing !== undefined) {
        return existing;
    }
    await api.createBuilder({ baseUrl, jwt, name: BUILDER, config: { type: "Server", params: { server_id: SERVER } } });
    const created = await find();
    if (created === undefined) {
        throw new Error("komodo Server builder was not created");
    }
    return created;
};

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
        const builderId = await ensureBuilder(api, parsed.komodoUrl, jwt);
        const config = buildConfig(parsed, builderId);
        const existing = (await api.listBuilds({ baseUrl: parsed.komodoUrl, jwt })).find((item) => item.name === ctx.id);
        if (existing === undefined) {
            await api.createBuild({ baseUrl: parsed.komodoUrl, jwt, name: ctx.id, config });
        } else {
            await api.updateBuild({ baseUrl: parsed.komodoUrl, jwt, id: existing.id, config });
        }
        return {};
    },
});
