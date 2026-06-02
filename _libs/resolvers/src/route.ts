import type { Ref, SecretRef } from "@puristic/deploy-protocol";
import { makeRef } from "@puristic/deploy-protocol";
import { tunnelId } from "./ids.js";
import type { ResolvedNode } from "./resource-types.js";

const slug = (hostname: string): string =>
    hostname
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");

// One entry in a host tunnel's ingress: a public hostname routed to a service's internal url.
export interface IngressPair {
    readonly hostname: string;
    readonly service: Ref<string>;
}

// Exposing one public hostname through the host's Cloudflare Tunnel produces two things kept in sync: a
// proxied DNS CNAME (hostname -> the tunnel's cfargotunnel hostname), owned by the cf-route node, and an
// ingress rule (hostname -> the service's internal url), aggregated onto the host's tunnel node. The
// cf-route id is derived from the hostname so it is stable.
export const exposeRoute = (
    cloudflareId: string,
    hostId: string,
    hostname: string,
    service: Ref<string>,
    apiToken: SecretRef,
): { route: ResolvedNode; ingress: IngressPair } => ({
    route: {
        id: `${cloudflareId}-${slug(hostname)}`,
        type: "cf-route",
        inputs: { hostname, zoneId: makeRef(cloudflareId, "zoneId"), apiToken, cname: makeRef(tunnelId(hostId), "cname") },
        explicitDependsOn: [cloudflareId, tunnelId(hostId)],
    },
    ingress: { hostname, service },
});
