import type { ResourceType } from "./resource-types.js";

// The single runtime authority for which outputs each resource type produces, keyed exhaustively by
// the closed ResourceType union (a missing type is a compile error). Values mirror the Ref<string>
// output props declared on the handle interfaces in @intentic/sdk; the core outputs test asserts
// the two never drift. The engine reads this to know which produced/observed values to expose as
// {$ref:"id.output"} targets — providers never declare their own outputs.
export const OUTPUTS: Readonly<Record<ResourceType, readonly string[]>> = Object.freeze({
    host: ["internalIp", "publicIp"],
    cloudflare: ["zoneId", "accountId"],
    "cf-route": ["url"],
    tunnel: ["tunnelId", "cname"],
    forgejo: ["url", "internalUrl", "runnerToken", "gitToken", "packagesToken"],
    // Identity nodes are pure sinks: usernames/org names are authored or deterministic literals the resolver
    // passes around directly, so nothing refs an output off them (like ci/forgejo-notify/komodo-notify).
    "forgejo-user": [],
    "forgejo-org": [],
    "forgejo-team": [],
    repo: ["cloneUrl", "sshUrl"],
    "control-repo": ["cloneUrl", "sshUrl"],
    "forgejo-runner": [],
    komodo: ["url", "internalUrl"],
    // Komodo Periphery deployed on a worker host (outbound to Core) — a pure side-effect like the runner.
    "komodo-periphery": [],
    // A worker host registered as a Komodo Server — exposes the server name the deployment provider targets.
    "komodo-server": ["serverName"],
    "komodo-user": [],
    ci: [],
    deployment: ["internalUrl", "url"],
    "forgejo-notify": [],
    "komodo-notify": [],
    signoz: ["url", "internalUrl", "otlpEndpoint"],
    // A scheduled backup job — a pure sink (nothing refs an output off it), like ci/forgejo-runner.
    backup: [],
    // GitHub inventory node — resolves the PAT's owner (user or org).
    github: ["owner"],
    // GitHub repo — same output shape as the Forgejo "repo" type.
    "gh-repo": ["cloneUrl", "sshUrl"],
    // GitHub Actions workflow + repo secrets — a pure sink, like "ci".
    "gh-ci": [],
    // Container on the host managed via SSH (no Komodo) — same output shape as "deployment".
    "gh-deployment": ["internalUrl", "url"],
});
