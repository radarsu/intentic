import type { ResourceType } from "./resource-types.js";

// The single runtime authority for which outputs each resource type produces, keyed exhaustively by
// the closed ResourceType union (a missing type is a compile error). Values mirror the Ref<string>
// output props declared on the handle interfaces in @puristic/deploy-core; the core outputs test asserts
// the two never drift. The engine reads this to know which produced/observed values to expose as
// {$ref:"id.output"} targets — providers never declare their own outputs.
export const OUTPUTS: Readonly<Record<ResourceType, readonly string[]>> = Object.freeze({
    host: ["internalIp", "publicIp"],
    cloudflare: ["zoneId"],
    "cf-route": ["url"],
    tunnel: ["tunnelId", "cname"],
    forgejo: ["url", "internalUrl", "runnerToken"],
    repo: ["cloneUrl", "sshUrl"],
    "control-repo": ["cloneUrl", "sshUrl"],
    "forgejo-runner": [],
    komodo: ["url", "internalUrl"],
    app: [],
    deployment: ["internalUrl", "url"],
    "forgejo-notify": [],
    "komodo-notify": [],
    "deploy-hook": [],
});
