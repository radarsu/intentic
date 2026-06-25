import type { Provider, ResolvedInputs } from "@intentic/engine";
import { z } from "zod";
import { parseInputs } from "./inputs.js";
import type { DeploymentConfig, KomodoApi } from "./komodo-api.js";
import { komodoApi } from "./komodo-api.js";

// The Komodo server the deployment runs on (auto-registered by KOMODO_FIRST_SERVER_NAME in komodo.ts).
const SERVER = "Local";

const deploymentSchema = z.object({
    komodoUrl: z.string(),
    adminUser: z.string(),
    adminPassword: z.string(),
    app: z.string(),
    branch: z.string(),
    domain: z.string(),
    internalIp: z.string(),
    // The deterministic host port the deployment publishes, computed by the resolver (deploymentPort) so it
    // matches the tunnel's ingress for this environment exactly.
    port: z.coerce.number(),
    env: z.record(z.string(), z.unknown()).default({}),
});
type DeploymentInputs = z.infer<typeof deploymentSchema>;
const parse = (inputs: ResolvedInputs): DeploymentInputs => parseInputs(deploymentSchema, inputs, "deployment");

const BUILD_TIMEOUT_MS = 180_000;
const BUILD_INTERVAL_MS = 3_000;

// RunBuild returns as soon as the build STARTS (it runs async on the builder), but execute/Deploy only runs
// an already-built image — so deploying right after RunBuild races an image that does not exist yet and
// silently runs nothing (the deployment never converges). Capture the build's last_built_at, kick the build,
// and poll until it advances (a fresh image exists) before returning; time out with the build's git-fetch
// error if it never produces one.
const runBuildAndWait = async (api: KomodoApi, baseUrl: string, jwt: string, build: string): Promise<void> => {
    const before = (await api.getBuild({ baseUrl, jwt, build })).lastBuiltAt;
    await api.runBuild({ baseUrl, jwt, build });
    const deadline = Date.now() + BUILD_TIMEOUT_MS;
    for (;;) {
        const status = await api.getBuild({ baseUrl, jwt, build });
        if (status.lastBuiltAt > before) {
            return;
        }
        if (Date.now() >= deadline) {
            throw new Error(
                `komodo build "${build}" did not finish within ${BUILD_TIMEOUT_MS}ms${status.remoteError ? `: ${status.remoteError}` : ""}`,
            );
        }
        await new Promise((resolve) => setTimeout(resolve, BUILD_INTERVAL_MS));
    }
};

const outputsFor = (parsed: DeploymentInputs): Record<string, unknown> => ({
    url: `https://${parsed.domain}`,
    internalUrl: `http://${parsed.internalIp}:${parsed.port}`,
});

const deploymentConfig = (parsed: DeploymentInputs): Record<string, unknown> => ({
    server_id: SERVER,
    image: { type: "Build", params: { build_id: parsed.app } },
    branch: parsed.branch,
    // Komodo's CreateDeployment rejects the "host:container" string form; it wants the struct form. Ignored
    // at runtime under the default host network, but the published port is the host port either way.
    ports: [{ local: String(parsed.port), container: String(parsed.port) }],
    environment: Object.entries(parsed.env).map(([variable, value]) => ({ variable, value: String(value) })),
    restart: "unless-stopped",
    // So a build triggered by the push webhook (Komodo's build listener) redeploys this environment.
    redeploy_on_build: true,
});

// Collapse Komodo's env to a stable, order-independent set of canonical "K=V" lines. Komodo stores it as a
// multiline string with spaces around "=" ("  PORT = 27748\n"); we send the array-of-{variable,value} form.
// Normalize both: trim each line, then trim around the first "=".
const normalizeEnv = (env: string | readonly { readonly variable: string; readonly value: string }[]): string => {
    const lines = typeof env === "string" ? env.split("\n") : env.map(({ variable, value }) => `${variable}=${value}`);
    return lines
        .map((line) => line.trim())
        .filter((line) => line !== "")
        .map((line) => {
            const eq = line.indexOf("=");
            return eq < 0 ? line : `${line.slice(0, eq).trim()}=${line.slice(eq + 1).trim()}`;
        })
        .sort()
        .join("\n");
};

// A stable key over the one authored MUTABLE field the provisioner converges: env. server_id, the build
// image, the deterministic ports, and branch (a Build concept Komodo does not store on a Deployment) are all
// fixed/absent at the Deployment level, so they are excluded — keeping diff pure and free of ctx.id.
const desiredKey = (parsed: DeploymentInputs): string =>
    JSON.stringify(normalizeEnv(Object.entries(parsed.env).map(([variable, value]) => ({ variable, value: String(value) }))));
const observedKey = (config: DeploymentConfig): string => JSON.stringify(normalizeEnv(config.environment));

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
            return { outputs: outputsFor(parsed), detail: { config } };
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
            await api.createDeployment({ baseUrl: parsed.komodoUrl, jwt, name: ctx.id, config: deploymentConfig(parsed) });
        } else {
            await api.updateDeployment({ baseUrl: parsed.komodoUrl, jwt, id: existing.id, config: deploymentConfig(parsed) });
        }
        // execute/Deploy only pulls + runs — build the image (and WAIT for it) first so there is something to run.
        await runBuildAndWait(api, parsed.komodoUrl, jwt, parsed.app);
        await api.deploy({ baseUrl: parsed.komodoUrl, jwt, deployment: ctx.id });
        return outputsFor(parsed);
    },
});
