import type { HostInput, IntentSet } from "@intentic/need-resolver";
import type { ResolvedNode } from "@intentic/resources";
import { resolveAppGitHub } from "./app-github.js";
import { tunnelId, tunnelName } from "./ids.js";
import { IMAGES } from "./images.js";
import type { IngressPair } from "./route.js";
import { resolveService } from "./service.js";
import { makeRef } from "@intentic/graph";

// Extract the SSH connection block from a HostInput.
const sshOf = (input: HostInput): Record<string, unknown> => ({
    address: input.address,
    user: input.user,
    sshKey: input.sshKey,
    ...(input.port !== undefined ? { port: input.port } : {}),
});

// Build the concrete RawNodes for the GitHub path. Much simpler than the Forgejo emit: no Forgejo, no
// Komodo, no runner. Each app gets a gh-repo + per-env gh-ci + gh-deployment. The host, cloudflare, tunnel,
// and cf-route nodes are unchanged.
export const emitGitHub = (intent: IntentSet, zone: string): ResolvedNode[] => {
    if (intent.apps.length === 0 && intent.services.length === 0) {
        return [];
    }

    const cloudflare = intent.cloudflare;
    if (cloudflare === undefined) {
        throw new Error("intent declares apps/services but no Cloudflare; declare it with i.have.cloudflare");
    }

    const github = intent.github;
    if (github === undefined) {
        throw new Error("GitHub emit called but no GitHub declared; this is a resolver bug");
    }

    const apiToken = cloudflare.input.apiToken;
    const hostById = new Map(intent.hosts.map((h) => [h.id, h]));
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

    // The GitHub inventory node.
    nodes.push({
        id: github.id,
        type: "github",
        inputs: {
            token: github.input.token,
            ...(github.input.owner !== undefined ? { owner: github.input.owner } : {}),
        },
        explicitDependsOn: [],
    });

    // Per-host ingress buckets (for tunnel aggregation).
    const ingressByHost = new Map<string, IngressPair[]>();

    // Validate app → service references.
    const serviceIds = new Set(intent.services.map((service) => service.id));
    for (const app of intent.apps) {
        if (app.observe !== undefined && !serviceIds.has(app.observe)) {
            throw new Error(`app "${app.id}" observes unknown service "${app.observe}"; declare it with i.want.service`);
        }
    }

    // --- Apps: all go through GitHub ---

    for (const app of intent.apps) {
        const resolved = resolveAppGitHub(app, github.id, apiToken, zone, github.input.token);
        nodes.push(...resolved.nodes);
        const hostIngress = ingressByHost.get(app.on) ?? [];
        hostIngress.push(...resolved.ingress);
        ingressByHost.set(app.on, hostIngress);
    }

    // --- Services: placed on the specified host (unchanged from Forgejo path) ---

    for (const service of intent.services) {
        const host = hostById.get(service.on)!;
        const resolved = resolveService(service, host.input, zone, apiToken);
        nodes.push(...resolved.nodes);
        const hostIngress = ingressByHost.get(service.on) ?? [];
        hostIngress.push(...resolved.ingress);
        ingressByHost.set(service.on, hostIngress);
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
