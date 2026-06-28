import type { SecretRef } from "@intentic/graph";
import { env, httpOk, makeRef } from "@intentic/graph";
import type { HostInput, WorkspaceIntent } from "@intentic/need-resolver";
import type { ResolvedNode } from "@intentic/resources";
import { previewDomain } from "./ids.js";
import { IMAGES } from "./images.js";
import type { IngressPair } from "./route.js";
import { exposeRoute } from "./route.js";

// The host-published port the runner's preview reverse proxy listens on; the wildcard tunnel ingress routes
// `*.preview.<zone>` to it, and the runner fans out by Host header to each project's sandbox.
const PREVIEW_PORT = 8088;
// The shared internal docker network the runner and every sandbox attach to (the runner creates it).
const NETWORK = "intentic-workspace";

// The per-host AI-agent workspace runner: one container deployed onto the host over SSH (like the platform's
// Forgejo/Komodo) from the pinned runner image, plus its WILDCARD `*.preview.<zone>` Cloudflare route. The
// node carries the host SSH creds + internal ip and the sandbox image it spawns project sandboxes from; it
// gates on its host-internal /healthz so readiness passes before the tunnel + DNS route exist. Returns the
// exposure's ingress pair so the caller aggregates it onto the host's tunnel.
export const resolveWorkspace = (
    intent: WorkspaceIntent,
    host: HostInput,
    zone: string,
    apiToken: SecretRef,
): { nodes: ResolvedNode[]; ingress: IngressPair[] } => {
    const ssh = {
        address: host.address,
        user: host.user,
        sshKey: host.sshKey,
        ...(host.port !== undefined ? { port: host.port } : {}),
    };
    const domain = previewDomain(zone);
    const exposure = exposeRoute(intent.expose, intent.on, domain, PREVIEW_PORT, apiToken);
    const nodes: ResolvedNode[] = [
        {
            id: intent.id,
            type: "workspace",
            inputs: {
                server: makeRef(intent.on),
                ...ssh,
                internalIp: makeRef<string>(intent.on, "internalIp"),
                domain,
                zone,
                previewPort: PREVIEW_PORT,
                network: NETWORK,
                image: IMAGES.runner,
                sandboxImage: IMAGES.sandbox,
                // Opt into the control plane: the runner dials platformUrl with the platform-supplied
                // RUNNER_TOKEN. Both are omitted (preview-only) unless the author set platformUrl.
                ...(intent.platformUrl !== undefined ? { platformUrl: intent.platformUrl, runnerToken: env("RUNNER_TOKEN") } : {}),
                // The runner exports this as ANTHROPIC_BASE_URL into each sandbox; omitted ⇒ Anthropic's cloud.
                ...(intent.agentBaseUrl !== undefined ? { agentBaseUrl: intent.agentBaseUrl } : {}),
            },
            explicitDependsOn: [],
            readyWhen: httpOk(makeRef<string>(intent.id, "healthUrl"), { timeout: "120s" }),
        },
        exposure.route,
    ];
    return { nodes, ingress: [exposure.ingress] };
};
