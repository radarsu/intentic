import type { SecretRef } from "@puristic/deploy-protocol";
import { env, httpOk, makeRef } from "@puristic/deploy-protocol";
import { adminUsername, forgejoId, gitDomain, komodoDomain, komodoId, runnerId } from "./ids.js";
import type { HostInput } from "./inputs.js";
import type { ResolvedNode } from "./resource-types.js";
import type { IngressPair } from "./route.js";
import { exposeRoute } from "./route.js";

export interface PlatformRefs {
    readonly forgejo: string;
    readonly deploy: string;
    // The cf-route ids for the platform's public hostnames, so the control-plane nodes that call those
    // public URLs can depend on the route being live (DNS + tunnel) before they run.
    readonly gitRoute: string;
    readonly komodoRoute: string;
}

// The fixed host ports the platform services listen on (Forgejo HTTP, Komodo Core), mirrored by their
// providers; the tunnel routes git.<zone>/komodo.<zone> to these.
const FORGEJO_PORT = 3000;
const KOMODO_PORT = 9120;

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
    // The platform services are deployed ONTO the host over SSH (like the tunnel connector), so every
    // deploy-style node carries the host's SSH creds + its internal ip. internalUrl/readyWhen are keyed
    // to the host-internal address so they're reachable before the Cloudflare tunnel + DNS routes exist.
    const ssh = {
        address: host.address,
        user: host.user,
        sshKey: host.sshKey,
        ...(host.port !== undefined ? { port: host.port } : {}),
    };
    const internalIp = makeRef<string>(hostId, "internalIp");
    const git = exposeRoute(cloudflareId, hostId, gitDomain(zone), FORGEJO_PORT, apiToken);
    const komodo = exposeRoute(cloudflareId, hostId, komodoDomain(zone), KOMODO_PORT, apiToken);

    const nodes: ResolvedNode[] = [
        {
            id: forgejo,
            type: "forgejo",
            inputs: { server, ...ssh, internalIp, domain: gitDomain(zone), adminUser: adminUsername, adminPassword: env("FORGEJO_ADMIN_PASSWORD") },
            explicitDependsOn: [],
            readyWhen: httpOk(makeRef<string>(forgejo, "internalUrl"), { timeout: "120s" }),
        },
        {
            id: runnerId(hostId),
            type: "forgejo-runner",
            inputs: { server, ...ssh, instanceUrl: makeRef<string>(forgejo, "url"), token: makeRef<string>(forgejo, "runnerToken") },
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
                forgejoUrl: makeRef<string>(forgejo, "internalUrl"),
                runnerToken: makeRef<string>(forgejo, "runnerToken"),
                adminUser: adminUsername,
                adminPassword: env("KOMODO_ADMIN_PASSWORD"),
                // Shared with each deploy-hook so Komodo validates the incoming push webhook's signature.
                webhookSecret: env("KOMODO_WEBHOOK_SECRET"),
            },
            explicitDependsOn: [],
            readyWhen: httpOk(makeRef<string>(deploy, "internalUrl"), { timeout: "90s" }),
        },
        git.route,
        komodo.route,
    ];
    return { nodes, refs: { forgejo, deploy, gitRoute: git.route.id, komodoRoute: komodo.route.id }, ingress: [git.ingress, komodo.ingress] };
};
