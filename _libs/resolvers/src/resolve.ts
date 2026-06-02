import type { RawNode } from "@puristic/deploy-protocol";
import { resolveApp } from "./app.js";
import type { IntentSet } from "./intent.js";
import type { PlatformRefs } from "./platform.js";
import { resolvePlatform } from "./platform.js";
import type { ResolvedNode } from "./resource-types.js";

// The "what that requires" layer: an IntentSet (have + want) resolved into the concrete RawNodes the
// compiler folds into a DesiredStateGraph. Inventory becomes its own nodes; each app's support stack is
// derived, sharing one git/CI/deploy platform per host across all apps.
export const resolve = (intent: IntentSet): RawNode[] => {
    const zoneById = new Map(intent.clouds.map((cloud) => [cloud.id, cloud.input.zone]));
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
    const platformByHost = new Map<string, PlatformRefs>();
    for (const app of intent.apps) {
        if (platformByHost.has(app.on)) {
            continue;
        }
        const zone = zoneById.get(app.expose);
        if (zone === undefined) {
            throw new Error(`cloudflare "${app.expose}" has no zone; declare it with i.have.cloudflare`);
        }
        const platform = resolvePlatform(app.on, app.expose, zone);
        platformByHost.set(app.on, platform.refs);
        nodes.push(...platform.nodes);
    }

    for (const app of intent.apps) {
        const platform = platformByHost.get(app.on);
        if (platform === undefined) {
            throw new Error(`no platform derived for host "${app.on}"`);
        }
        nodes.push(...resolveApp(app, platform));
    }

    return nodes;
};
