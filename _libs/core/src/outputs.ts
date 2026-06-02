import type { ResourceType } from "./types.js";

// The single runtime authority for which outputs each resource type produces, keyed exhaustively by
// the closed ResourceType union (a missing type is a compile error). Values mirror the Ref<string>
// output props declared on the handle interfaces in types.ts; outputs.test.ts asserts the two never
// drift. The engine reads this to know which produced/observed values to expose as {$ref:"id.output"}
// targets — providers never declare their own outputs.
export const OUTPUTS: Readonly<Record<ResourceType, readonly string[]>> = Object.freeze({
    host: ["internalIp", "publicIp"],
    cloudflare: ["zoneId"],
    "cf-route": ["url"],
    forgejo: ["url", "internalUrl", "runnerToken"],
    repo: ["cloneUrl", "sshUrl"],
    "forgejo-runner": [],
    komodo: ["url", "internalUrl", "passkey"],
    app: [],
    deployment: ["internalUrl", "url"],
});
