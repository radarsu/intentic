import type { Ref, SecretRef } from "@puristic/deploy-protocol";
import { env, httpOk, makeRef } from "@puristic/deploy-protocol";
import { adminUsername, deployHookId, deploymentId, deploymentPort, forgejoNotifyId, gitDomain, komodoNotifyId, repoId } from "./ids.js";
import type { AppIntent } from "./intent.js";
import type { PlatformRefs } from "./platform.js";
import type { ResolvedNode } from "./resource-types.js";
import type { IngressPair } from "./route.js";
import { exposeRoute } from "./route.js";

// The app resolver: everything shipping an app from source beyond the shared platform — a repo, the app
// node wired to the repo + deploy orchestrator, and per environment a deployment, its Cloudflare route, and
// a push-to-deploy webhook. The config nodes (repo/app/deployment/notify/deploy-hook) talk to the Forgejo
// or Komodo HTTP API, so each carries the backend `url` ref + the admin password it logs in with. The
// deployment gates on its host-internal url so readiness passes before the tunnel + DNS routes exist.
// Returns each environment's ingress pair so the caller can aggregate the host's tunnel ingress.
export const resolveApp = (
    intent: AppIntent,
    platform: PlatformRefs,
    apiToken: SecretRef,
    zone: string,
): { nodes: ResolvedNode[]; ingress: IngressPair[] } => {
    const ref = (id: string, output: string): Ref<string> => makeRef(id, output) as Ref<string>;
    const repo = repoId(intent.id);
    const forgejoUrl = ref(platform.forgejo, "url");
    const komodoUrl = ref(platform.deploy, "url");
    const forgejoAdmin = { adminUser: adminUsername, adminPassword: env("FORGEJO_ADMIN_PASSWORD") };
    const komodoAdmin = { adminUser: adminUsername, adminPassword: env("KOMODO_ADMIN_PASSWORD") };

    const nodes: ResolvedNode[] = [
        {
            id: repo,
            type: "repo",
            inputs: { name: intent.id, private: true, forgejoUrl, domain: gitDomain(zone), ...forgejoAdmin },
            // Calls the public git URL, so it must run after git's DNS + tunnel route is live.
            explicitDependsOn: [platform.forgejo, platform.gitRoute],
        },
        {
            id: intent.id,
            type: "app",
            inputs: {
                source: ref(repo, "cloneUrl"),
                repoName: intent.id,
                deployer: makeRef(platform.deploy),
                komodoUrl,
                gitDomain: gitDomain(zone),
                ...komodoAdmin,
            },
            explicitDependsOn: [platform.deploy, platform.komodoRoute, repo],
        },
    ];
    const ingress: IngressPair[] = [];

    for (const [name, environment] of Object.entries(intent.environments)) {
        const id = deploymentId(intent.id, name);
        const port = deploymentPort(id);
        nodes.push({
            id,
            type: "deployment",
            inputs: {
                app: makeRef(intent.id),
                name,
                branch: environment.branch,
                domain: environment.domain,
                server: makeRef(intent.on),
                internalIp: ref(intent.on, "internalIp"),
                port,
                komodoUrl,
                ...komodoAdmin,
                ...(environment.env !== undefined ? { env: environment.env } : {}),
            },
            explicitDependsOn: [intent.id, platform.komodoRoute],
            readyWhen: environment.readyWhen ?? httpOk(ref(id, "internalUrl"), { timeout: "60s" }),
        });
        const exposure = exposeRoute(intent.expose, intent.on, environment.domain, port, apiToken);
        nodes.push(exposure.route);
        ingress.push(exposure.ingress);
        // Push-to-deploy: a Forgejo repo webhook that calls Komodo's deploy listener for this environment
        // when its branch is pushed; the shared secret is what Komodo validates the incoming hook against.
        nodes.push({
            id: deployHookId(intent.id, name),
            type: "deploy-hook",
            inputs: {
                forgejoUrl,
                ...forgejoAdmin,
                repoName: intent.id,
                komodoUrl,
                deployment: id,
                branch: environment.branch,
                secret: env("KOMODO_WEBHOOK_SECRET"),
            },
            // Registers a Forgejo webhook via the public git URL, so it waits on git's route.
            explicitDependsOn: [repo, id, platform.gitRoute],
        });
    }

    // CI/CD notifications: when the author asks for them, derive the two native Discord sinks — a Forgejo
    // repo webhook on build results (CI) and a Komodo alerter scoped to this app's deployments on deploy
    // results (CD). Pure sinks: no outputs. Each carries the backend admin creds it authenticates with.
    if (intent.notify !== undefined) {
        nodes.push({
            id: forgejoNotifyId(intent.id),
            type: "forgejo-notify",
            inputs: { forgejoUrl, ...forgejoAdmin, repoName: intent.id, webhook: intent.notify.discord, events: ["build"] },
            explicitDependsOn: [platform.forgejo, platform.gitRoute, repo],
        });
        const targets = Object.keys(intent.environments).map((environment) => deploymentId(intent.id, environment));
        nodes.push({
            id: komodoNotifyId(intent.id),
            type: "komodo-notify",
            inputs: { komodoUrl, ...komodoAdmin, targets, webhook: intent.notify.discord, events: ["deploy"] },
            explicitDependsOn: [platform.deploy, platform.komodoRoute, intent.id, ...targets],
        });
    }

    return { nodes, ingress };
};
