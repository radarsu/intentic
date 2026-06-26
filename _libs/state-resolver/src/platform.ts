import type { SecretRef } from "@intentic/graph";
import { generated, httpOk, makeRef } from "@intentic/graph";
import type { HostInput } from "@intentic/need-resolver";
import type { ResolvedNode } from "@intentic/resources";
import { adminUsername, forgejoId, gitDomain, komodoDomain, komodoId, registryAuthority, runnerId } from "./ids.js";
import { IMAGES } from "./images.js";
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
// adminUser "intentic", intentic-generated admin passwords, domain-derived health gates. Returns each
// exposure's ingress pair so the caller can aggregate the host's tunnel ingress.
// When guarded updates are on (host.updatePolicy === "guarded" + a backup is declared), the stateful
// services carry the restic repo + image so a pin bump runs as a snapshot/rollback transaction; the
// password/creds come from the on-host restic.env the backup provider writes.
export interface GuardConfig {
    readonly repo: string;
    readonly resticImage: string;
}

export const resolvePlatform = (
    hostId: string,
    cloudflareId: string,
    zone: string,
    apiToken: SecretRef,
    host: HostInput,
    guard: GuardConfig | undefined,
): { nodes: ResolvedNode[]; refs: PlatformRefs; ingress: IngressPair[] } => {
    // The guarded-update inputs, spread onto the stateful (forgejo/komodo) nodes only when enabled.
    const guarded = guard !== undefined ? { guardRepo: guard.repo, resticImage: guard.resticImage } : {};
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
            inputs: {
                server,
                ...ssh,
                internalIp,
                domain: gitDomain(zone),
                adminUser: adminUsername,
                adminPassword: generated("FORGEJO_ADMIN_PASSWORD"),
                image: IMAGES.forgejo,
                ...guarded,
            },
            explicitDependsOn: [],
            readyWhen: httpOk(makeRef<string>(forgejo, "internalUrl"), { timeout: "120s" }),
        },
        {
            id: runnerId(hostId),
            type: "forgejo-runner",
            // The runner runs ON the host, so it reaches Forgejo at its internal url directly — using the
            // public url would force a needless round-trip through the tunnel (and depend on DNS being live).
            inputs: {
                server,
                ...ssh,
                instanceUrl: makeRef<string>(forgejo, "internalUrl"),
                token: makeRef<string>(forgejo, "runnerToken"),
                image: IMAGES.forgejoRunner,
                jobImage: IMAGES.forgejoRunnerJob,
            },
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
                adminPassword: generated("KOMODO_ADMIN_PASSWORD"),
                // The admin's token + account, so Komodo can clone the private app repos. The git provider
                // domain is derived from forgejoUrl above (the internal http://<ip>:3000 authority).
                gitAccount: adminUsername,
                gitToken: makeRef<string>(forgejo, "gitToken"),
                // The Forgejo built-in registry + the admin's packages token, written as a [[docker_registry]]
                // account so Komodo can pull the private app images CI pushes.
                registry: registryAuthority(zone),
                packagesToken: makeRef<string>(forgejo, "packagesToken"),
                coreImage: IMAGES.komodoCore,
                peripheryImage: IMAGES.komodoPeriphery,
                ferretdbImage: IMAGES.ferretdb,
                postgresImage: IMAGES.postgresDocumentdb,
                ...guarded,
            },
            explicitDependsOn: [],
            readyWhen: httpOk(makeRef<string>(deploy, "internalUrl"), { timeout: "90s" }),
        },
        git.route,
        komodo.route,
    ];
    return { nodes, refs: { forgejo, deploy, gitRoute: git.route.id, komodoRoute: komodo.route.id }, ingress: [git.ingress, komodo.ingress] };
};
