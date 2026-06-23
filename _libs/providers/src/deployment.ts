import type { Provider, ResolvedInputs } from "@puristic/deploy-engine";
import { z } from "zod";
import { parseInputs } from "./inputs.js";
import type { DeploymentConfig, KomodoApi } from "./komodo-api.js";
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

// A stable, order-independent key over the authored fields the provisioner converges: server, branch,
// build image, and env. Ports are derived deterministically from the node id (they never drift), so they
// are deliberately excluded — keeping diff pure and free of ctx.id.
const envKey = (environment: readonly { readonly variable: string; readonly value: string }[]): string =>
    [...environment]
        .map(({ variable, value }) => `${variable}=${value}`)
        .sort()
        .join("\n");
const desiredKey = (parsed: DeploymentInputs): string =>
    JSON.stringify([
        parsed.server,
        parsed.branch,
        parsed.app,
        envKey(Object.entries(parsed.env).map(([variable, value]) => ({ variable, value: String(value) }))),
    ]);
const observedKey = (config: DeploymentConfig): string =>
    JSON.stringify([config.server_id, config.branch, config.image.params.build, envKey(config.environment)]);

// One Komodo Deployment per environment (named <app>.<env> = ctx.id), built from the app's Build on the
// environment's branch and exposed on a deterministic host port. read returns undefined until Komodo is up
// (komodoUrl PENDING) or unreachable, otherwise it surfaces the deployment's current config. diff converges
// on that config alone — runtime liveness is owned by the push->Komodo deploy loop, not the provisioner —
// so a stopped-but-unchanged deployment is a noop. apply create-or-updates and triggers the deploy, which
// now fires only on a genuine create or config change.
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
            const config = await api.getDeployment({ baseUrl: parsed.komodoUrl, jwt, deployment: ctx.id });
            return { outputs: outputsFor(parsed, ctx.id), detail: { config } };
        } catch (error) {
            ctx.log(`deployment "${ctx.id}": komodo not reachable yet, treating as not-yet-created: ${String(error)}`);
            return undefined;
        }
    },
    diff: (inputs, observed) => {
        const config = observed.detail?.["config"] as DeploymentConfig | undefined;
        if (config === undefined || observedKey(config) !== desiredKey(parse(inputs))) {
            return { action: "update", reason: "deployment config differs from desired" };
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
