import { makeRef } from "@puristic/deploy-protocol";
import { resolveApp } from "./app.js";
import { tunnelId, tunnelName } from "./ids.js";
import type { CloudflareInput, HostInput } from "./inputs.js";
import type { IntentSet } from "./intent.js";
import type { PlatformRefs } from "./platform.js";
import { resolvePlatform } from "./platform.js";
import type { ResolvedNode } from "./resource-types.js";
import type { IngressPair } from "./route.js";

// One concrete choice of option per need: `${capability}:${scope}` -> option id. The candidate generator
// builds these from the catalog; emit turns one into the support stack it describes.
export interface Assignment {
    readonly byNeed: ReadonlyMap<string, string>;
}

// The option set this emitter knows how to build. Today's only valid combination; once a second option
// (e.g. Gitlab) lands, emit branches on the assignment instead of asserting it.
const supportedOptions = new Set(["forgejo", "komodo", "ssh-linux", "cloudflare-tunnel"]);

// Everything the tunnel node for one host needs: the platform's exposed-service refs, the Cloudflare
// account it connects through, the host's SSH connection (cloudflared runs there), and the accumulated
// ingress for every service exposed on that host.
interface HostPlatform {
    readonly cloudflareId: string;
    readonly cloud: CloudflareInput;
    readonly host: HostInput;
    readonly refs: PlatformRefs;
    readonly ingress: IngressPair[];
}

// Build the concrete RawNodes for one assignment. Inventory becomes its own nodes; each app's support
// stack is derived, sharing one git/CI/deploy platform per host across all apps. Each host that exposes
// anything also gets one Cloudflare Tunnel node owning the host's aggregated ingress. The compiler folds
// the result into one reconciliation-target artifact (a DesiredStateGraph).
export const emit = (intent: IntentSet, assignment: Assignment): ResolvedNode[] => {
    for (const optionId of assignment.byNeed.values()) {
        if (!supportedOptions.has(optionId)) {
            throw new Error(`unsupported option "${optionId}"; the emitter only implements ${[...supportedOptions].join("/")}`);
        }
    }

    const zoneById = new Map(intent.clouds.map((cloud) => [cloud.id, cloud.input.zone]));
    const cloudById = new Map(intent.clouds.map((cloud) => [cloud.id, cloud.input]));
    const hostById = new Map(intent.hosts.map((host) => [host.id, host.input]));
    const nodes: ResolvedNode[] = [];

    for (const host of intent.hosts) {
        nodes.push({
            id: host.id,
            type: "host",
            inputs: {
                address: host.input.address,
                user: host.input.user,
                sshKey: host.input.sshKey,
                ...(host.input.port !== undefined ? { port: host.input.port } : {}),
            },
            explicitDependsOn: [],
        });
    }
    for (const cloud of intent.clouds) {
        nodes.push({
            id: cloud.id,
            type: "cloudflare",
            inputs: { accountId: cloud.input.accountId, apiToken: cloud.input.apiToken, zone: cloud.input.zone },
            explicitDependsOn: [],
        });
    }

    // Share-per-host: derive one git/CI/deploy platform per distinct host across all apps.
    const platformByHost = new Map<string, HostPlatform>();
    for (const app of intent.apps) {
        if (platformByHost.has(app.on)) {
            continue;
        }
        const zone = zoneById.get(app.expose);
        const cloud = cloudById.get(app.expose);
        if (zone === undefined || cloud === undefined) {
            throw new Error(`cloudflare "${app.expose}" has no zone; declare it with i.have.cloudflare`);
        }
        const host = hostById.get(app.on);
        if (host === undefined) {
            throw new Error(`app "${app.id}" targets unknown host "${app.on}"; declare it with i.have.host`);
        }
        const platform = resolvePlatform(app.on, app.expose, zone, cloud.apiToken, host);
        platformByHost.set(app.on, { cloudflareId: app.expose, cloud, host, refs: platform.refs, ingress: [...platform.ingress] });
        nodes.push(...platform.nodes);
    }

    for (const app of intent.apps) {
        const platform = platformByHost.get(app.on);
        if (platform === undefined) {
            throw new Error(`no platform derived for host "${app.on}"`);
        }
        const cloud = cloudById.get(app.expose);
        if (cloud === undefined) {
            throw new Error(`cloudflare "${app.expose}" has no zone; declare it with i.have.cloudflare`);
        }
        const resolved = resolveApp(app, platform.refs, cloud.apiToken, cloud.zone);
        nodes.push(...resolved.nodes);
        platform.ingress.push(...resolved.ingress);
    }

    // One Cloudflare Tunnel per host that exposes anything: cloudflared runs on the host (hence the
    // copied SSH creds), connects through the platform's Cloudflare account, and owns the host's
    // aggregated ingress. Its ingress is (hostname -> host-internal port), computable from the host's
    // internal ip alone, so the tunnel depends only on the host + Cloudflare and can come up BEFORE the
    // control plane that reaches Forgejo/Komodo through its public routes. Routes reference its cname.
    for (const [hostId, platform] of platformByHost) {
        nodes.push({
            id: tunnelId(hostId),
            type: "tunnel",
            inputs: {
                name: tunnelName(hostId),
                accountId: platform.cloud.accountId,
                apiToken: platform.cloud.apiToken,
                address: platform.host.address,
                user: platform.host.user,
                sshKey: platform.host.sshKey,
                ...(platform.host.port !== undefined ? { port: platform.host.port } : {}),
                internalIp: makeRef(hostId, "internalIp"),
                ingress: platform.ingress,
            },
            explicitDependsOn: [platform.cloudflareId, hostId],
        });
    }

    return nodes;
};
