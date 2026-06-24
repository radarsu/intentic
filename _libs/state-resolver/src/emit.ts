import { makeRef } from "@intentic/graph";
import type { IntentSet } from "@intentic/need-resolver";
import type { ResolvedNode } from "@intentic/resources";
import { resolveApp } from "./app.js";
import { tunnelId, tunnelName } from "./ids.js";
import { resolvePlatform } from "./platform.js";

// One concrete choice of option per need: `${capability}:${scope}` -> option id. The state resolver
// builds this from the catalog; emit turns it into the support stack it describes.
export interface Assignment {
    readonly byNeed: ReadonlyMap<string, string>;
}

// The option set this emitter knows how to build. Today's only valid combination; once a second option
// (e.g. Gitlab) lands, emit branches on the assignment instead of asserting it.
const supportedOptions = new Set(["forgejo", "komodo", "ssh-linux", "cloudflare-tunnel"]);

// Build the concrete RawNodes for one assignment. The host and Cloudflare are authored inventory: one host
// node + one cloudflare node carrying the connection the author declared with i.have.host / i.have.cloudflare.
// Every app shares one git/CI/deploy platform on that host, and one Cloudflare Tunnel owns the host's
// aggregated ingress. The compiler folds the result into one desired-state artifact (a DesiredStateGraph).
export const emit = (intent: IntentSet, assignment: Assignment): ResolvedNode[] => {
    for (const optionId of assignment.byNeed.values()) {
        if (!supportedOptions.has(optionId)) {
            throw new Error(`unsupported option "${optionId}"; the emitter only implements ${[...supportedOptions].join("/")}`);
        }
    }

    if (intent.apps.length === 0) {
        return [];
    }

    const host = intent.host;
    const cloudflare = intent.cloudflare;
    if (host === undefined || cloudflare === undefined) {
        throw new Error("intent declares apps but no host/Cloudflare; declare them with i.have.host and i.have.cloudflare");
    }

    const zone = cloudflare.input.zone;
    const apiToken = cloudflare.input.apiToken;
    const ssh = {
        address: host.input.address,
        user: host.input.user,
        sshKey: host.input.sshKey,
        ...(host.input.port !== undefined ? { port: host.input.port } : {}),
    };
    const nodes: ResolvedNode[] = [
        {
            id: host.id,
            type: "host",
            inputs: { ...ssh },
            explicitDependsOn: [],
        },
        {
            id: cloudflare.id,
            type: "cloudflare",
            inputs: { accountId: cloudflare.input.accountId, apiToken, zone },
            explicitDependsOn: [],
        },
    ];

    // The git/CI/deploy platform every app on the host requires, shared once across all apps.
    const platform = resolvePlatform(host.id, cloudflare.id, zone, apiToken, host.input);
    nodes.push(...platform.nodes);
    const ingress = [...platform.ingress];

    for (const app of intent.apps) {
        const resolved = resolveApp(app, platform.refs, apiToken, zone);
        nodes.push(...resolved.nodes);
        ingress.push(...resolved.ingress);
    }

    // One Cloudflare Tunnel for the host: cloudflared runs on the host (hence the SSH creds), connects
    // through the Cloudflare account, and owns the host's aggregated ingress. Its ingress is (hostname ->
    // host-internal port), computable from the host's internal ip alone, so it can come up BEFORE the
    // control plane that reaches Forgejo/Komodo through its public routes. Routes reference its cname.
    nodes.push({
        id: tunnelId(host.id),
        type: "tunnel",
        inputs: {
            name: tunnelName(host.id),
            accountId: cloudflare.input.accountId,
            apiToken,
            ...ssh,
            internalIp: makeRef(host.id, "internalIp"),
            ingress,
        },
        explicitDependsOn: [cloudflare.id, host.id],
    });

    return nodes;
};
