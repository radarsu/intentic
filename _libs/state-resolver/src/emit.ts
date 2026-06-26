import { generated, makeRef } from "@intentic/graph";
import type { HostInput, IntentSet } from "@intentic/need-resolver";
import { controlPlaneHostId } from "@intentic/need-resolver";
import type { ResolvedNode } from "@intentic/resources";
import { resolveApp } from "./app.js";
import { resolveBackup } from "./backup.js";
import { emitGitHub } from "./emit-github.js";
import { resolveIdentities } from "./identity.js";
import { adminUsername, tunnelId, tunnelName } from "./ids.js";
import { IMAGES } from "./images.js";
import { resolvePlatform } from "./platform.js";
import type { IngressPair } from "./route.js";
import { resolveService } from "./service.js";

// One concrete choice of option per need: `${capability}:${scope}` -> option id. The state resolver
// builds this from the catalog; emit turns it into the support stack it describes.
export interface Assignment {
    readonly byNeed: ReadonlyMap<string, string>;
}

// The option set this emitter knows how to build. Today's only valid combination; once a second option
// (e.g. Gitlab) lands, emit branches on the assignment instead of asserting it.
const supportedOptions = new Set(["forgejo", "komodo", "ssh-linux", "cloudflare-tunnel"]);

// Extract the SSH connection block from a HostInput (shared by every node deployed onto a host over SSH).
const sshOf = (input: HostInput): Record<string, unknown> => ({
    address: input.address,
    user: input.user,
    sshKey: input.sshKey,
    ...(input.port !== undefined ? { port: input.port } : {}),
});

// Build the concrete RawNodes for one assignment. One shared control plane (Forgejo + Komodo + runner) is
// derived onto the control-plane host (first declared host with apps). Worker hosts get Komodo Periphery
// in outbound mode and are registered as Komodo Servers. Each host with ingress gets its own Cloudflare
// Tunnel. All apps share one git/CI/deploy platform regardless of which host they run on.
export const emit = (intent: IntentSet, assignment: Assignment, zone: string | undefined): ResolvedNode[] => {
    // GitHub path: when the assignment resolved source-control to "github", delegate entirely — no Forgejo,
    // no Komodo, no runner. The two paths share host/cloudflare/tunnel/cf-route/service.
    const isGitHub = [...assignment.byNeed.values()].includes("github");
    if (isGitHub) {
        if (zone === undefined && (intent.apps.length > 0 || intent.services.length > 0)) {
            throw new Error(
                "intent exposes apps/services through Cloudflare but no zone was provided; the CLI discovers it from the API token before resolving",
            );
        }
        return emitGitHub(intent, zone!);
    }

    for (const optionId of assignment.byNeed.values()) {
        if (!supportedOptions.has(optionId)) {
            throw new Error(`unsupported option "${optionId}"; the emitter only implements ${[...supportedOptions].join("/")}`);
        }
    }

    if (intent.apps.length === 0 && intent.services.length === 0) {
        return [];
    }

    const cloudflare = intent.cloudflare;
    if (cloudflare === undefined) {
        throw new Error("intent declares apps/services but no Cloudflare; declare it with i.have.cloudflare");
    }
    if (zone === undefined) {
        throw new Error(
            "intent exposes apps/services through Cloudflare but no zone was provided; the CLI discovers it from the API token before resolving",
        );
    }

    const cpId = controlPlaneHostId(intent);
    if (cpId === undefined) {
        throw new Error("intent declares apps/services but no host; declare one with i.have.host");
    }

    const apiToken = cloudflare.input.apiToken;
    const hostById = new Map(intent.hosts.map((h) => [h.id, h]));
    const cpHost = hostById.get(cpId)!;
    const nodes: ResolvedNode[] = [];

    // Emit ALL host inventory nodes.
    for (const host of intent.hosts) {
        nodes.push({
            id: host.id,
            type: "host",
            inputs: { ...sshOf(host.input) },
            explicitDependsOn: [],
        });
    }

    // The single Cloudflare inventory node.
    nodes.push({
        id: cloudflare.id,
        type: "cloudflare",
        inputs: { apiToken, zone },
        explicitDependsOn: [],
    });

    // Per-host ingress buckets (for tunnel aggregation).
    const ingressByHost = new Map<string, IngressPair[]>();

    // --- Shared control plane on the CP host ---

    const serviceIds = new Set(intent.services.map((service) => service.id));

    if (intent.apps.length > 0) {
        // Guarded updates need a restic repo to snapshot into; enabled only when the host opts in AND a
        // backup destination is declared (the provider reuses its on-host restic.env for the password).
        const guard =
            cpHost.input.updatePolicy === "guarded" && intent.backup !== undefined
                ? { repo: intent.backup.input.repo, resticImage: IMAGES.backup }
                : undefined;
        const platform = resolvePlatform(cpId, cloudflare.id, zone, apiToken, cpHost.input, guard);
        nodes.push(...platform.nodes);
        const cpIngress = [...platform.ingress];
        ingressByHost.set(cpId, cpIngress);

        // Validate app -> service references.
        for (const app of intent.apps) {
            if (app.observe !== undefined && !serviceIds.has(app.observe)) {
                throw new Error(`app "${app.id}" observes unknown service "${app.observe}"; declare it with i.want.service`);
            }
        }

        // --- Worker hosts: Periphery + Server registration ---

        const workerHostIds = new Set(
            [...intent.apps.map((a) => a.on), ...intent.services.map((s) => s.on)].filter((id) => id !== cpId),
        );
        for (const hostId of workerHostIds) {
            const host = hostById.get(hostId)!;
            const peripheryId = `${hostId}-periphery`;
            const serverId = `${hostId}-server`;

            nodes.push({
                id: peripheryId,
                type: "komodo-periphery",
                inputs: {
                    ...sshOf(host.input),
                    coreAddress: makeRef<string>(platform.refs.deploy, "url"),
                    serverName: hostId,
                    image: IMAGES.komodoPeriphery,
                },
                explicitDependsOn: [hostId, platform.refs.deploy, platform.refs.deployRoute],
            });

            nodes.push({
                id: serverId,
                type: "komodo-server",
                inputs: {
                    komodoUrl: makeRef<string>(platform.refs.deploy, "url"),
                    adminUser: adminUsername,
                    adminPassword: generated("KOMODO_ADMIN_PASSWORD"),
                    serverName: hostId,
                },
                explicitDependsOn: [peripheryId, platform.refs.deploy, platform.refs.deployRoute],
            });

            // Initialize ingress bucket for worker host.
            if (!ingressByHost.has(hostId)) {
                ingressByHost.set(hostId, []);
            }
        }

        // --- Apps: all go through the shared platform ---

        for (const app of intent.apps) {
            const resolved = resolveApp(app, platform.refs, apiToken, zone, cpId);
            nodes.push(...resolved.nodes);
            // Route ingress goes to the host the app runs ON (its tunnel), not the CP host.
            const hostIngress = ingressByHost.get(app.on) ?? [];
            hostIngress.push(...resolved.ingress);
            ingressByHost.set(app.on, hostIngress);
        }

        // The declared people + teams and the cross-cutting grant graph. One Forgejo, one Komodo, one
        // set of identity accounts — all scoped to the control-plane host.
        nodes.push(...resolveIdentities(intent, platform.refs, cpId));
    }

    // --- Services: placed on the specified host ---

    for (const service of intent.services) {
        const host = hostById.get(service.on)!;
        const resolved = resolveService(service, host.input, zone, apiToken);
        nodes.push(...resolved.nodes);
        const hostIngress = ingressByHost.get(service.on) ?? [];
        hostIngress.push(...resolved.ingress);
        ingressByHost.set(service.on, hostIngress);
    }

    // --- Backup on the control-plane host (where Forgejo+Komodo data lives) ---

    if (intent.backup !== undefined && intent.apps.length > 0) {
        const signozService = intent.services.find((service) => service.kind === "signoz");
        nodes.push(resolveBackup(cpId, cpHost.input, intent.backup.input, signozService?.id));
    }

    // --- One Cloudflare Tunnel per host that has ingress ---

    for (const [hostId, ingress] of ingressByHost) {
        if (ingress.length === 0) {
            continue;
        }
        const host = hostById.get(hostId)!;
        nodes.push({
            id: tunnelId(hostId),
            type: "tunnel",
            inputs: {
                name: tunnelName(hostId),
                accountId: makeRef(cloudflare.id, "accountId"),
                apiToken,
                ...sshOf(host.input),
                internalIp: makeRef(hostId, "internalIp"),
                ingress,
                image: IMAGES.cloudflared,
            },
            explicitDependsOn: [cloudflare.id, hostId],
        });
    }

    return nodes;
};
