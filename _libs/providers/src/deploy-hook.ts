import type { Provider, ResolvedInputs } from "@intentic/engine";
import { z } from "zod";
import type { ForgejoApi, ForgejoHook } from "./forgejo-api.js";
import { forgejoApi } from "./forgejo-api.js";
import { parseInputs } from "./inputs.js";

const deployHookSchema = z.object({
    forgejoUrl: z.string(),
    adminUser: z.string(),
    adminPassword: z.string(),
    repoName: z.string(),
    komodoUrl: z.string(),
    deployment: z.string(),
    branch: z.string(),
    secret: z.string(),
});
type DeployHookInputs = z.infer<typeof deployHookSchema>;
const parse = (inputs: ResolvedInputs): DeployHookInputs => parseInputs(deployHookSchema, inputs, "deploy-hook");

// Komodo's incoming deploy listener for this environment's Deployment. Forgejo posts a gitea-format hook
// here on push; the github auth type + shared secret signature compatibility is confirmed at integration.
const listenerUrl = (parsed: DeployHookInputs): string => `${parsed.komodoUrl}/listener/github/deployment/${parsed.deployment}/deploy`;
const findHook = (hooks: readonly ForgejoHook[], url: string): ForgejoHook | undefined => hooks.find((hook) => hook.config["url"] === url);

// Push-to-deploy: a Forgejo repo webhook that triggers a Komodo deploy of this environment on push. Both
// url inputs must be resolved (PENDING => return undefined so a plan proceeds); matched statelessly by the
// listener url it targets.
export const createDeployHookProvider = (api: ForgejoApi = forgejoApi): Provider => ({
    read: async (inputs, ctx) => {
        if (typeof inputs["forgejoUrl"] !== "string" || typeof inputs["komodoUrl"] !== "string") {
            return undefined;
        }
        const parsed = parse(inputs);
        try {
            const hook = findHook(
                await api.listHooks({
                    baseUrl: parsed.forgejoUrl,
                    user: parsed.adminUser,
                    password: parsed.adminPassword,
                    owner: parsed.adminUser,
                    name: parsed.repoName,
                }),
                listenerUrl(parsed),
            );
            if (hook === undefined) {
                return undefined;
            }
            return { outputs: {} };
        } catch (error) {
            ctx.log(`deploy-hook "${ctx.id}": forgejo not reachable yet, treating as not-yet-created: ${String(error)}`);
            return undefined;
        }
    },
    diff: () => ({ action: "noop" }),
    apply: async (inputs) => {
        const parsed = parse(inputs);
        const url = listenerUrl(parsed);
        const config = { url, content_type: "json", secret: parsed.secret };
        const existing = findHook(
            await api.listHooks({
                baseUrl: parsed.forgejoUrl,
                user: parsed.adminUser,
                password: parsed.adminPassword,
                owner: parsed.adminUser,
                name: parsed.repoName,
            }),
            url,
        );
        if (existing === undefined) {
            await api.createHook({
                baseUrl: parsed.forgejoUrl,
                user: parsed.adminUser,
                password: parsed.adminPassword,
                owner: parsed.adminUser,
                name: parsed.repoName,
                type: "gitea",
                config,
                events: ["push"],
            });
        } else {
            await api.updateHook({
                baseUrl: parsed.forgejoUrl,
                user: parsed.adminUser,
                password: parsed.adminPassword,
                owner: parsed.adminUser,
                name: parsed.repoName,
                id: existing.id,
                config,
                events: ["push"],
            });
        }
        return {};
    },
});
