import type { Ref } from "@puristic/deploy-protocol";
import { httpOk, makeRef } from "@puristic/deploy-protocol";
import { deploymentId, repoId } from "./ids.js";
import type { AppIntent } from "./intent.js";
import type { PlatformRefs } from "./platform.js";
import type { ResolvedNode } from "./resource-types.js";
import { routeNode } from "./route.js";

// The app resolver: everything shipping an app from source requires beyond the shared platform — a repo,
// the app node wired to the repo + deploy orchestrator, and one deployment + Cloudflare route per
// environment (default health gate https://<domain>/healthz unless the author supplied readyWhen).
export const resolveApp = (intent: AppIntent, platform: PlatformRefs): ResolvedNode[] => {
    const ref = (id: string, output: string): Ref<string> => makeRef(id, output) as Ref<string>;
    const repo = repoId(intent.id);

    const nodes: ResolvedNode[] = [
        { id: repo, type: "repo", inputs: { name: intent.id, private: true }, explicitDependsOn: [platform.forgejo] },
        { id: intent.id, type: "app", inputs: { source: ref(repo, "cloneUrl"), deployer: makeRef(platform.deploy) }, explicitDependsOn: [] },
    ];

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
        nodes.push(routeNode(intent.expose, environment.domain, ref(id, "internalUrl")));
    }

    return nodes;
};
