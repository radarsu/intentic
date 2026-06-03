import type { Provider, ResolvedInputs } from "@puristic/deploy-engine";
import { z } from "zod";
import { parseInputs } from "./inputs.js";
import type { KomodoApi } from "./komodo-api.js";
import { komodoApi } from "./komodo-api.js";

const deploymentSchema = z.object({
    komodoUrl: z.string(),
    adminUser: z.string(),
    adminPassword: z.string(),
    app: z.string(),
    branch: z.string(),
    domain: z.string(),
    server: z.string(),
    internalIp: z.string(),
    env: z.record(z.string(), z.unknown()).default({}),
});
type DeploymentInputs = z.infer<typeof deploymentSchema>;
const parse = (inputs: ResolvedInputs): DeploymentInputs => parseInputs(deploymentSchema, inputs, "deployment");

// A deterministic host port per deployment so multiple environments co-located on one host do not collide;
// the provider both publishes this port and re-derives internalUrl from it, keeping them consistent. The
// real published-port strategy is confirmed at integration.
const portFor = (id: string): number => 20000 + [...id].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) % 10000, 7);

const outputsFor = (parsed: DeploymentInputs, id: string): Record<string, unknown> => ({
    url: `https://${parsed.domain}`,
    internalUrl: `http://${parsed.internalIp}:${portFor(id)}`,
});

const deploymentConfig = (parsed: DeploymentInputs, id: string): Record<string, unknown> => ({
    server_id: parsed.server,
    image: { type: "Build", params: { build: parsed.app } },
    branch: parsed.branch,
    ports: [`${portFor(id)}:${portFor(id)}`],
    environment: Object.entries(parsed.env).map(([variable, value]) => ({ variable, value })),
});

// One Komodo Deployment per environment (named <app>.<env> = ctx.id), built from the app's Build on the
// environment's branch and exposed on a deterministic host port. read returns undefined until Komodo is up
// (komodoUrl PENDING) or unreachable; diff forces a (re)deploy when the deployment is not Running. apply
// create-or-updates and triggers the deploy.
export const createDeploymentProvider = (api: KomodoApi = komodoApi): Provider => ({
    read: async (inputs, ctx) => {
        if (typeof inputs["komodoUrl"] !== "string") {
            return undefined;
        }
        const parsed = parse(inputs);
        try {
            const jwt = await api.login({ baseUrl: parsed.komodoUrl, username: parsed.adminUser, password: parsed.adminPassword });
            const deployment = (await api.listDeployments({ baseUrl: parsed.komodoUrl, jwt })).find((item) => item.name === ctx.id);
            if (deployment === undefined) {
                return undefined;
            }
            return { outputs: outputsFor(parsed, ctx.id), detail: { state: deployment.state } };
        } catch (error) {
            ctx.log(`deployment "${ctx.id}": komodo not reachable yet, treating as not-yet-created: ${String(error)}`);
            return undefined;
        }
    },
    diff: (_inputs, observed) => {
        if (observed.detail?.["state"] !== "Running") {
            return { action: "update", reason: `deployment is not Running (state ${String(observed.detail?.["state"])})` };
        }
        return { action: "noop" };
    },
    apply: async (inputs, _observed, ctx) => {
        const parsed = parse(inputs);
        const jwt = await api.login({ baseUrl: parsed.komodoUrl, username: parsed.adminUser, password: parsed.adminPassword });
        const existing = (await api.listDeployments({ baseUrl: parsed.komodoUrl, jwt })).find((item) => item.name === ctx.id);
        if (existing === undefined) {
            await api.createDeployment({ baseUrl: parsed.komodoUrl, jwt, name: ctx.id, config: deploymentConfig(parsed, ctx.id) });
        } else {
            await api.updateDeployment({ baseUrl: parsed.komodoUrl, jwt, id: existing.id, config: deploymentConfig(parsed, ctx.id) });
        }
        await api.deploy({ baseUrl: parsed.komodoUrl, jwt, deployment: ctx.id });
        return outputsFor(parsed, ctx.id);
    },
});
