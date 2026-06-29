import { generated, makeRef } from "@intentic/graph";
import type { BackupInput, HostInput, IntentSet } from "@intentic/need-resolver";
import { controlPlaneHostId } from "@intentic/need-resolver";
import type { ResolvedNode } from "@intentic/resources";
import { resolveApp } from "./app.js";
import { resolveBacking } from "./backing.js";
import { defaultBackupInput, resolveBackup } from "./backup.js";
import { emitGitHub } from "./emit-github.js";
import { resolveIdentities } from "./identity.js";
import { adminUsername, tunnelId, tunnelName } from "./ids.js";
import { IMAGES } from "./images.js";
import { resolvePlatform } from "./platform.js";
import type { IngressPair } from "./route.js";
import { resolveService } from "./service.js";
import { resolveWorkspace } from "./workspace.js";

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
        if (intent.backings.length > 0) {
            throw new Error("backings (i.want.database/cache/…) are not yet supported on the GitHub stack; use the Forgejo stack");
        }
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

    if (intent.apps.length === 0 && intent.services.length === 0 && intent.workspaces.length === 0 && intent.backings.length === 0) {
        return [];
    }

    const cloudflare = intent.cloudflare;
    if (cloudflare === undefined) {
        throw new Error("intent declares apps/services/workspaces/backings but no Cloudflare; declare it with i.have.cloudflare");
    }
    if (zone === undefined) {
        throw new Error(
            "intent exposes apps/services through Cloudflare but no zone was provided; the CLI discovers it from the API token before resolving",
        );
    }

    const cpId = controlPlaneHostId(intent);
    if (cpId === undefined) {
        throw new Error("intent declares apps/services/backings but no host; declare one with i.have.host");
    }

    const apiToken = cloudflare.input.apiToken;
    const hostById = new Map(intent.hosts.map((h) => [h.id, h]));
    // The backing instances apps may bind, keyed by id, each with the host it runs on. Validates each backing
    // targets a declared host (apps reference these by id in their `use`). Passed into resolveApp so a binding
    // node can be emitted onto the instance's host.
    const backingById = new Map<string, { intent: (typeof intent.backings)[number]; host: HostInput }>();
    for (const backing of intent.backings) {
        const host = hostById.get(backing.on);
        if (host === undefined) {
            throw new Error(`backing "${backing.id}" targets undeclared host "${backing.on}"; declare it with i.have.host`);
        }
        backingById.set(backing.id, { intent: backing, host: host.input });
    }
    const cpHost = hostById.get(cpId)!;
    // Restic is on-by-default: when the operator declares no i.have.backup(), synthesize a default
    // destination (on-host repo + generated password) so a snapshot can always be taken and the host-move
    // path always exists. A declared backup is used verbatim.
    const backupInput: BackupInput = intent.backup?.input ?? defaultBackupInput();
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

    // The Discord back-communication channel: guild + categories + channels + webhooks. Emitted when
    // the operator declares i.have.discord(). The apps input lists only apps that wire notify: discord.
    if (intent.discord !== undefined) {
        const notifiedApps = intent.apps.filter((app) => app.notify === intent.discord!.id).map((app) => app.id);
        nodes.push({
            id: intent.discord.id,
            type: "discord",
            inputs: {
                botToken: intent.discord.input.botToken,
                zone,
                apps: notifiedApps,
            },
            explicitDependsOn: [],
        });
    }

    // Per-host ingress buckets (for tunnel aggregation).
    const ingressByHost = new Map<string, IngressPair[]>();

    // --- Shared control plane on the CP host ---

    const serviceIds = new Set(intent.services.map((service) => service.id));

    if (intent.apps.length > 0) {
        // Guarded updates need a restic repo to snapshot into; enabled when the host opts in (a backup
        // destination is always present now, the provider reuses its on-host restic.env for the password).
        const guard = cpHost.input.updatePolicy === "guarded" ? { repo: backupInput.repo, resticImage: IMAGES.backup } : undefined;
        const platform = resolvePlatform(cpId, cloudflare.id, zone, apiToken, cpHost.input, guard);
        nodes.push(...platform.nodes);
        const cpIngress = [...platform.ingress];
        ingressByHost.set(cpId, cpIngress);

        // Validate app -> service references.
        for (const app of intent.apps) {
            if (app.observe !== undefined && !serviceIds.has(app.observe)) {
                throw new Error(`app "${app.id}" observes unknown service "${app.observe}"; declare it with i.want.service`);
            }
            // Validate app -> backing references: the target must be a declared backing AND its capability must
            // match what the app recorded (guards a stale id reused across capabilities).
            for (const binding of app.use ?? []) {
                const backing = backingById.get(binding.target);
                if (backing === undefined) {
                    throw new Error(`app "${app.id}" uses unknown backing "${binding.target}"; declare it with i.want.${binding.capability}`);
                }
                if (backing.intent.capability !== binding.capability) {
                    throw new Error(`app "${app.id}" uses "${binding.target}" as ${binding.capability} but it is a ${backing.intent.capability}`);
                }
            }
        }

        // --- Worker hosts: Periphery + Server registration ---

        const workerHostIds = new Set([...intent.apps.map((a) => a.on), ...intent.services.map((s) => s.on)].filter((id) => id !== cpId));
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
            const resolved = resolveApp(app, platform.refs, apiToken, zone, cpId, backingById);
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

    // --- Workspaces: the per-host AI-agent runner, exposed via a wildcard *.preview.<zone> route ---

    for (const workspace of intent.workspaces) {
        const host = hostById.get(workspace.on)!;
        const resolved = resolveWorkspace(workspace, host.input, zone, apiToken);
        nodes.push(...resolved.nodes);
        const hostIngress = ingressByHost.get(workspace.on) ?? [];
        hostIngress.push(...resolved.ingress);
        ingressByHost.set(workspace.on, hostIngress);
    }

    // --- Backing instances: each deployed onto its host over SSH. Internal-only (database/cache) contribute
    // no ingress; exposed ones (auth, Phase 2) aggregate onto the host's tunnel like services. The per-app
    // binding nodes are emitted inside resolveApp (they require an app), not here. ---
    for (const backing of intent.backings) {
        const host = hostById.get(backing.on)!;
        const resolved = resolveBacking(backing, host.input, apiToken);
        nodes.push(...resolved.nodes);
        if (resolved.ingress.length > 0) {
            const hostIngress = ingressByHost.get(backing.on) ?? [];
            hostIngress.push(...resolved.ingress);
            ingressByHost.set(backing.on, hostIngress);
        }
    }

    // --- Backup on the control-plane host (where Forgejo+Komodo data lives). On-by-default: emitted for
    // every control plane so a snapshot can always be taken (and the host-move path always exists), using
    // the operator's declared destination or the synthesized on-host default. ---

    if (intent.apps.length > 0) {
        const signozService = intent.services.find((service) => service.kind === "signoz");
        nodes.push(resolveBackup(cpId, cpHost.input, backupInput, signozService?.id));
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
