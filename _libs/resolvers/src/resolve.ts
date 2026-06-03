import type { RawNode } from "@puristic/deploy-protocol";
import { resolveApp } from "./app.js";
import { tunnelId, tunnelName } from "./ids.js";
import type { CloudflareInput, HostInput } from "./inputs.js";
import type { IntentSet } from "./intent.js";
import type { PlatformRefs } from "./platform.js";
import { resolvePlatform } from "./platform.js";
import type { ResolvedNode } from "./resource-types.js";
import type { IngressPair } from "./route.js";

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

// The "what that requires" layer: an IntentSet (have + want) resolved into the concrete RawNodes the
// compiler folds into a DesiredStateGraph. Inventory becomes its own nodes; each app's support stack is
// derived, sharing one git/CI/deploy platform per host across all apps. Each host that exposes anything
// also gets one Cloudflare Tunnel node owning the host's aggregated ingress.
export const resolve = (intent: IntentSet): RawNode[] => {
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
    // aggregated ingress. Routes reference its cname; the service refs in ingress induce the dep edges.
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
                ingress: platform.ingress,
            },
            explicitDependsOn: [platform.cloudflareId, hostId],
        });
    }

    return nodes;
};
