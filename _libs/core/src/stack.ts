import { env, httpOk } from "./index.js";
import { makeRef } from "./ref.js";
import type { App, Cloudflare, CloudflareInput, Deployment, EnvironmentInput, Host, HostInput, RawNode, Ref, Stack, WantAppInput } from "./types.js";

const slug = (hostname: string): string =>
    hostname
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");

export const createStack = (): { stack: Stack; nodes: Map<string, RawNode> } => {
    const nodes = new Map<string, RawNode>();
    // Zone is needed to derive the platform's git./komodo. subdomains; platforms are shared per host.
    const zoneByCloudflare = new Map<string, string>();
    const platformByHost = new Map<string, { forgejo: string; deploy: string }>();

    const register = (node: RawNode): void => {
        if (nodes.has(node.id)) {
            throw new Error(`duplicate resource id: "${node.id}"`);
        }
        nodes.set(node.id, node);
    };

    const ref = (resourceId: string, output: string): Ref<string> => makeRef(resourceId, output) as Ref<string>;

    // --- Inventory ("what you have") ---

    const host = (id: string, input: HostInput): Host => {
        register({
            id,
            type: "host",
            inputs: { address: input.address, user: input.user, sshKey: input.sshKey, ...(input.port !== undefined ? { port: input.port } : {}) },
            explicitDependsOn: [],
        });
        return Object.freeze({ ...makeRef(id), internalIp: ref(id, "internalIp"), publicIp: ref(id, "publicIp") }) as Host;
    };

    const cloudflare = (id: string, input: CloudflareInput): Cloudflare => {
        register({
            id,
            type: "cloudflare",
            inputs: { accountId: input.accountId, apiToken: input.apiToken, zone: input.zone },
            explicitDependsOn: [],
        });
        zoneByCloudflare.set(id, input.zone);
        return Object.freeze({ ...makeRef(id), zoneId: ref(id, "zoneId") }) as Cloudflare;
    };

    // --- Routing: one Cloudflare route per public hostname (id derived from the hostname) ---

    const route = (expose: Cloudflare, hostname: string, target: Ref<string>): void => {
        register({
            id: `${expose.resourceId}-${slug(hostname)}`,
            type: "cf-route",
            inputs: { hostname, target },
            explicitDependsOn: [expose.resourceId],
        });
    };

    // --- Derived support stack for an app: Git+CI (Forgejo + runner) and a deploy orchestrator (Komodo),
    // shared per host. Forgejo/Komodo are exposed at git.<zone>/komodo.<zone> so push/CI/UI are reachable. ---

    const ensurePlatform = (on: Host, expose: Cloudflare): { forgejo: string; deploy: string } => {
        const hostId = on.resourceId;
        const existing = platformByHost.get(hostId);
        if (existing !== undefined) {
            return existing;
        }
        const zone = zoneByCloudflare.get(expose.resourceId);
        if (zone === undefined) {
            throw new Error(`cloudflare "${expose.resourceId}" has no zone; declare it with i.have.cloudflare`);
        }
        const forgejo = `${hostId}-git`;
        const deploy = `${hostId}-deploy`;
        register({
            id: forgejo,
            type: "forgejo",
            inputs: { server: on, domain: `git.${zone}`, adminUser: "admin", adminPassword: env("FORGEJO_ADMIN_PASSWORD") },
            explicitDependsOn: [],
            readyWhen: httpOk(`https://git.${zone}/api/healthz`, { timeout: "120s" }),
        });
        register({
            id: `${forgejo}-runner`,
            type: "forgejo-runner",
            inputs: { server: on, instanceUrl: ref(forgejo, "url"), token: ref(forgejo, "runnerToken") },
            explicitDependsOn: [],
        });
        register({
            id: deploy,
            type: "komodo",
            inputs: {
                server: on,
                domain: `komodo.${zone}`,
                forgejoUrl: ref(forgejo, "internalUrl"),
                runnerToken: ref(forgejo, "runnerToken"),
                adminPassword: env("KOMODO_ADMIN_PASSWORD"),
            },
            explicitDependsOn: [],
            readyWhen: httpOk(`https://komodo.${zone}/api/health`, { timeout: "90s" }),
        });
        route(expose, `git.${zone}`, ref(forgejo, "internalUrl"));
        route(expose, `komodo.${zone}`, ref(deploy, "internalUrl"));
        const platform = { forgejo, deploy };
        platformByHost.set(hostId, platform);
        return platform;
    };

    // --- Intent ("what you want"): an app. Everything it requires is derived from this single call. ---

    const app = <const E extends Record<string, EnvironmentInput>>(id: string, input: WantAppInput & { environments: E }): App<keyof E & string> => {
        const platform = ensurePlatform(input.on, input.expose);

        const repoId = `${id}-repo`;
        register({ id: repoId, type: "repo", inputs: { name: id, private: true }, explicitDependsOn: [platform.forgejo] });
        register({ id, type: "app", inputs: { source: ref(repoId, "cloneUrl"), deployer: makeRef(platform.deploy) }, explicitDependsOn: [] });

        const environments: Record<string, Deployment> = {};
        for (const [name, environment] of Object.entries(input.environments)) {
            const deploymentId = `${id}.${name}`;
            register({
                id: deploymentId,
                type: "deployment",
                inputs: {
                    app: makeRef(id),
                    name,
                    branch: environment.branch,
                    domain: environment.domain,
                    server: makeRef(input.on.resourceId),
                    ...(environment.env !== undefined ? { env: environment.env } : {}),
                },
                explicitDependsOn: [],
                readyWhen: environment.readyWhen ?? httpOk(`https://${environment.domain}/healthz`, { timeout: "60s" }),
            });
            route(input.expose, environment.domain, ref(deploymentId, "internalUrl"));
            environments[name] = Object.freeze({
                ...makeRef(deploymentId),
                internalUrl: ref(deploymentId, "internalUrl"),
                url: ref(deploymentId, "url"),
            }) as Deployment;
        }
        return Object.freeze({ ...makeRef(id), environments: Object.freeze(environments) }) as App<keyof E & string>;
    };

    const stack: Stack = { have: { host, cloudflare }, want: { app } };
    return { stack, nodes };
};
