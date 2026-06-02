import type { Ref } from "@puristic/deploy-protocol";
import type { ResolvedNode } from "./resource-types.js";

const slug = (hostname: string): string =>
    hostname
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");

// One Cloudflare route per public hostname; the id is derived from the hostname so it is stable.
export const routeNode = (cloudflareId: string, hostname: string, target: Ref<string>): ResolvedNode => ({
    id: `${cloudflareId}-${slug(hostname)}`,
    type: "cf-route",
    inputs: { hostname, target },
    explicitDependsOn: [cloudflareId],
});
