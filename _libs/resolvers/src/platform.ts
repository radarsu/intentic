import type { Ref, SecretRef } from "@puristic/deploy-protocol";
import { env, httpOk, makeRef } from "@puristic/deploy-protocol";
import { forgejoId, gitDomain, komodoDomain, komodoId, runnerId } from "./ids.js";
import type { HostInput } from "./inputs.js";
import type { ResolvedNode } from "./resource-types.js";
import type { IngressPair } from "./route.js";
import { exposeRoute } from "./route.js";

export interface PlatformRefs {
    readonly forgejo: string;
    readonly deploy: string;
}

// The git+CI and deploy-orchestrator stack every app on a host requires, shared per host: Forgejo, its
// runner, and Komodo, exposed at git.<zone>/komodo.<zone> so push/CI/UI are reachable. Terse defaults:
// adminUser "admin", env()-sourced admin passwords, domain-derived health gates. Returns each exposure's
// ingress pair so the caller can aggregate the host's tunnel ingress.
export const resolvePlatform = (
    hostId: string,
    cloudflareId: string,
    zone: string,
    apiToken: SecretRef,
    host: HostInput,
): { nodes: ResolvedNode[]; refs: PlatformRefs; ingress: IngressPair[] } => {
    const forgejo = forgejoId(hostId);
    const deploy = komodoId(hostId);
    const server = makeRef(hostId);
    const ref = (id: string, output: string): Ref<string> => makeRef(id, output) as Ref<string>;
    // The platform services are deployed ONTO the host over SSH (like the tunnel connector), so every
    // deploy-style node carries the host's SSH creds + its internal ip. internalUrl/readyWhen are keyed
    // to the host-internal address so they're reachable before the Cloudflare tunnel + DNS routes exist.
    const ssh = {
        address: host.address,
        user: host.user,
        sshKey: host.sshKey,
        ...(host.port !== undefined ? { port: host.port } : {}),
    };
    const internalIp = ref(hostId, "internalIp");
    const git = exposeRoute(cloudflareId, hostId, gitDomain(zone), ref(forgejo, "internalUrl"), apiToken);
    const komodo = exposeRoute(cloudflareId, hostId, komodoDomain(zone), ref(deploy, "internalUrl"), apiToken);

    const nodes: ResolvedNode[] = [
        {
            id: forgejo,
            type: "forgejo",
            inputs: { server, ...ssh, internalIp, domain: gitDomain(zone), adminUser: "admin", adminPassword: env("FORGEJO_ADMIN_PASSWORD") },
            explicitDependsOn: [],
            readyWhen: httpOk(ref(forgejo, "internalUrl"), { timeout: "120s" }),
        },
        {
            id: runnerId(hostId),
            type: "forgejo-runner",
            inputs: { server, ...ssh, instanceUrl: ref(forgejo, "url"), token: ref(forgejo, "runnerToken") },
            explicitDependsOn: [],
        },
        {
            id: deploy,
            type: "komodo",
            inputs: {
                server,
                ...ssh,
                internalIp,
                domain: komodoDomain(zone),
                forgejoUrl: ref(forgejo, "internalUrl"),
                runnerToken: ref(forgejo, "runnerToken"),
                adminPassword: env("KOMODO_ADMIN_PASSWORD"),
                // Shared with each deploy-hook so Komodo validates the incoming push webhook's signature.
                webhookSecret: env("KOMODO_WEBHOOK_SECRET"),
            },
            explicitDependsOn: [],
            readyWhen: httpOk(ref(deploy, "internalUrl"), { timeout: "90s" }),
        },
        git.route,
        komodo.route,
    ];
    return { nodes, refs: { forgejo, deploy }, ingress: [git.ingress, komodo.ingress] };
};
