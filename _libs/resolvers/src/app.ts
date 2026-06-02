import type { Ref, SecretRef } from "@puristic/deploy-protocol";
import { httpOk, makeRef } from "@puristic/deploy-protocol";
import { deploymentId, forgejoNotifyId, komodoNotifyId, repoId } from "./ids.js";
import type { AppIntent } from "./intent.js";
import type { PlatformRefs } from "./platform.js";
import type { ResolvedNode } from "./resource-types.js";
import type { IngressPair } from "./route.js";
import { exposeRoute } from "./route.js";

// The app resolver: everything shipping an app from source requires beyond the shared platform — a repo,
// the app node wired to the repo + deploy orchestrator, and one deployment + Cloudflare route per
// environment (default health gate https://<domain>/healthz unless the author supplied readyWhen).
// Returns each environment's ingress pair so the caller can aggregate the host's tunnel ingress.
export const resolveApp = (intent: AppIntent, platform: PlatformRefs, apiToken: SecretRef): { nodes: ResolvedNode[]; ingress: IngressPair[] } => {
    const ref = (id: string, output: string): Ref<string> => makeRef(id, output) as Ref<string>;
    const repo = repoId(intent.id);

    const nodes: ResolvedNode[] = [
        { id: repo, type: "repo", inputs: { name: intent.id, private: true }, explicitDependsOn: [platform.forgejo] },
        { id: intent.id, type: "app", inputs: { source: ref(repo, "cloneUrl"), deployer: makeRef(platform.deploy) }, explicitDependsOn: [] },
    ];
    const ingress: IngressPair[] = [];

    for (const [name, environment] of Object.entries(intent.environments)) {
        const id = deploymentId(intent.id, name);
        nodes.push({
            id,
            type: "deployment",
            inputs: {
                app: makeRef(intent.id),
                name,
                branch: environment.branch,
                domain: environment.domain,
                server: makeRef(intent.on),
                ...(environment.env !== undefined ? { env: environment.env } : {}),
            },
            explicitDependsOn: [],
            readyWhen: environment.readyWhen ?? httpOk(`https://${environment.domain}/healthz`, { timeout: "60s" }),
        });
        const exposure = exposeRoute(intent.expose, intent.on, environment.domain, ref(id, "internalUrl"), apiToken);
        nodes.push(exposure.route);
        ingress.push(exposure.ingress);
    }

    // CI/CD notifications: when the author asks for them, derive the two native Discord sinks — a Forgejo
    // repo webhook on build results (CI) and a Komodo alerter on deploy results (CD). Pure sinks: no
    // outputs, leaf nodes. The webhook secret flows through unresolved; the engine resolves it per apply.
    if (intent.notify !== undefined) {
        nodes.push({
            id: forgejoNotifyId(intent.id),
            type: "forgejo-notify",
            inputs: { forgejo: makeRef(platform.forgejo), repo: makeRef(repo), webhook: intent.notify.discord, events: ["build"] },
            explicitDependsOn: [platform.forgejo, repo],
        });
        nodes.push({
            id: komodoNotifyId(intent.id),
            type: "komodo-notify",
            inputs: { komodo: makeRef(platform.deploy), app: makeRef(intent.id), webhook: intent.notify.discord, events: ["deploy"] },
            explicitDependsOn: [platform.deploy, intent.id],
        });
    }

    return { nodes, ingress };
};
