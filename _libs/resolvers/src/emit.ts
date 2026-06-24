import { makeRef } from "@intentic/graph";
import { resolveApp } from "./app.js";
import { tunnelId, tunnelName } from "./ids.js";
import type { IntentSet } from "./intent.js";
import { CLOUDFLARE_ID, cloudflareAccountId, cloudflareApiToken, deriveZone, HOST_ID, hostConnection } from "./inventory.js";
import { resolvePlatform } from "./platform.js";
import type { ResolvedNode } from "./resource-types.js";

// One concrete choice of option per need: `${capability}:${scope}` -> option id. The candidate generator
// builds these from the catalog; emit turns one into the support stack it describes.
export interface Assignment {
    readonly byNeed: ReadonlyMap<string, string>;
}

// The option set this emitter knows how to build. Today's only valid combination; once a second option
// (e.g. Gitlab) lands, emit branches on the assignment instead of asserting it.
const supportedOptions = new Set(["forgejo", "komodo", "ssh-linux", "cloudflare-tunnel"]);

// Build the concrete RawNodes for one assignment. The host and Cloudflare are the implicit reconciled
// inventory: one host node + one cloudflare node, their connection values canonical env secrets filled at
// the decision/PR step. Every app shares one git/CI/deploy platform on that host, and one Cloudflare
// Tunnel owns the host's aggregated ingress. The compiler folds the result into one reconciliation-target
// artifact (a DesiredStateGraph).
export const emit = (intent: IntentSet, assignment: Assignment): ResolvedNode[] => {
    for (const optionId of assignment.byNeed.values()) {
        if (!supportedOptions.has(optionId)) {
            throw new Error(`unsupported option "${optionId}"; the emitter only implements ${[...supportedOptions].join("/")}`);
        }
    }

    if (intent.apps.length === 0) {
        return [];
    }

    const zone = deriveZone(intent.apps.flatMap((app) => Object.values(app.environments).map((environment) => environment.domain)));
    const nodes: ResolvedNode[] = [
        {
            id: HOST_ID,
            type: "host",
            inputs: { ...hostConnection },
            explicitDependsOn: [],
        },
        {
            id: CLOUDFLARE_ID,
            type: "cloudflare",
            inputs: { accountId: cloudflareAccountId, apiToken: cloudflareApiToken, zone },
            explicitDependsOn: [],
        },
    ];

    // The git/CI/deploy platform every app on the host requires, shared once across all apps.
    const platform = resolvePlatform(HOST_ID, CLOUDFLARE_ID, zone, cloudflareApiToken, hostConnection);
    nodes.push(...platform.nodes);
    const ingress = [...platform.ingress];

    for (const app of intent.apps) {
        const resolved = resolveApp(app, platform.refs, cloudflareApiToken, zone);
        nodes.push(...resolved.nodes);
        ingress.push(...resolved.ingress);
    }

    // One Cloudflare Tunnel for the host: cloudflared runs on the host (hence the SSH creds), connects
    // through the Cloudflare account, and owns the host's aggregated ingress. Its ingress is (hostname ->
    // host-internal port), computable from the host's internal ip alone, so it can come up BEFORE the
    // control plane that reaches Forgejo/Komodo through its public routes. Routes reference its cname.
    nodes.push({
        id: tunnelId(HOST_ID),
        type: "tunnel",
        inputs: {
            name: tunnelName(HOST_ID),
            accountId: cloudflareAccountId,
            apiToken: cloudflareApiToken,
            ...hostConnection,
            internalIp: makeRef(HOST_ID, "internalIp"),
            ingress,
        },
        explicitDependsOn: [CLOUDFLARE_ID, HOST_ID],
    });

    return nodes;
};
