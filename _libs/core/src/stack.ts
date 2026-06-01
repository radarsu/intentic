import { makeRef } from "./ref.js";
import type {
    App,
    AppInput,
    Cloudflare,
    CloudflareInput,
    Deployment,
    EnvironmentInput,
    Forgejo,
    ForgejoInput,
    ForgejoRunner,
    ForgejoRunnerInput,
    Komodo,
    KomodoInput,
    RawNode,
    Ref,
    Repo,
    RepoInput,
    Route,
    RouteInput,
    Server,
    ServerInput,
    Stack,
} from "./types.js";

export const createStack = (): { stack: Stack; nodes: Map<string, RawNode> } => {
    const nodes = new Map<string, RawNode>();

    const register = (node: RawNode): void => {
        if (nodes.has(node.id)) {
            throw new Error(`duplicate resource id: "${node.id}"`);
        }
        nodes.set(node.id, node);
    };

    const ref = (resourceId: string, output: string): Ref<string> => makeRef(resourceId, output) as Ref<string>;

    const server = (id: string, input: ServerInput): Server => {
        register({
            id,
            type: "server",
            inputs: { host: input.host, user: input.user, sshKey: input.sshKey, ...(input.port !== undefined ? { port: input.port } : {}) },
            explicitDependsOn: [],
        });
        return Object.freeze({ ...makeRef(id), internalIp: ref(id, "internalIp"), publicIp: ref(id, "publicIp") }) as Server;
    };

    const cloudflare = (id: string, input: CloudflareInput): Cloudflare => {
        register({
            id,
            type: "cloudflare",
            inputs: { accountId: input.accountId, apiToken: input.apiToken, zone: input.zone },
            explicitDependsOn: [],
        });
        const route = (routeId: string, routeInput: RouteInput): Route => {
            register({
                id: routeId,
                type: "cf-route",
                inputs: { hostname: routeInput.hostname, target: routeInput.target },
                explicitDependsOn: [id],
            });
            return Object.freeze({ ...makeRef(routeId), url: ref(routeId, "url") }) as Route;
        };
        return Object.freeze({ ...makeRef(id), zoneId: ref(id, "zoneId"), route }) as Cloudflare;
    };

    const forgejo = (id: string, input: ForgejoInput): Forgejo => {
        register({
            id,
            type: "forgejo",
            inputs: { server: input.server, domain: input.domain, adminUser: input.adminUser, adminPassword: input.adminPassword },
            explicitDependsOn: input.dependsOn !== undefined ? input.dependsOn.map((handle) => handle.resourceId) : [],
            ...(input.readyWhen !== undefined ? { readyWhen: input.readyWhen } : {}),
        });
        const repo = (repoId: string, repoInput: RepoInput): Repo => {
            register({
                id: repoId,
                type: "repo",
                inputs: { name: repoInput.name, ...(repoInput.private !== undefined ? { private: repoInput.private } : {}) },
                explicitDependsOn: [id],
            });
            return Object.freeze({ ...makeRef(repoId), cloneUrl: ref(repoId, "cloneUrl"), sshUrl: ref(repoId, "sshUrl") }) as Repo;
        };
        return Object.freeze({
            ...makeRef(id),
            url: ref(id, "url"),
            internalUrl: ref(id, "internalUrl"),
            runnerToken: ref(id, "runnerToken"),
            repo,
        }) as Forgejo;
    };

    const forgejoRunner = (id: string, input: ForgejoRunnerInput): ForgejoRunner => {
        register({
            id,
            type: "forgejo-runner",
            inputs: { server: input.server, instanceUrl: input.instanceUrl, token: input.token },
            explicitDependsOn: [],
        });
        return Object.freeze({ ...makeRef(id) }) as ForgejoRunner;
    };

    const komodo = (id: string, input: KomodoInput): Komodo => {
        register({
            id,
            type: "komodo",
            inputs: {
                server: input.server,
                domain: input.domain,
                forgejoUrl: input.forgejoUrl,
                runnerToken: input.runnerToken,
                adminPassword: input.adminPassword,
            },
            explicitDependsOn: [],
            ...(input.readyWhen !== undefined ? { readyWhen: input.readyWhen } : {}),
        });
        return Object.freeze({ ...makeRef(id), url: ref(id, "url"), internalUrl: ref(id, "internalUrl"), passkey: ref(id, "passkey") }) as Komodo;
    };

    const app = <const E extends readonly EnvironmentInput[]>(id: string, input: AppInput<E>): App<E[number]["name"]> => {
        register({
            id,
            type: "app",
            inputs: { source: input.source, deployer: input.deployer },
            explicitDependsOn: [],
        });
        const environments: Record<string, Deployment> = {};
        for (const environment of input.environments) {
            const deploymentId = `${id}.${environment.name}`;
            register({
                id: deploymentId,
                type: "deployment",
                inputs: {
                    app: makeRef(id),
                    name: environment.name,
                    branch: environment.branch,
                    domain: environment.domain,
                    server: environment.server,
                    ...(environment.env !== undefined ? { env: environment.env } : {}),
                },
                explicitDependsOn: [],
                ...(environment.readyWhen !== undefined ? { readyWhen: environment.readyWhen } : {}),
            });
            environments[environment.name] = Object.freeze({
                ...makeRef(deploymentId),
                internalUrl: ref(deploymentId, "internalUrl"),
                url: ref(deploymentId, "url"),
            }) as Deployment;
        }
        return Object.freeze({ ...makeRef(id), environments: Object.freeze(environments) }) as App<E[number]["name"]>;
    };

    const stack: Stack = { server, cloudflare, forgejo, forgejoRunner, komodo, app };
    return { stack, nodes };
};
