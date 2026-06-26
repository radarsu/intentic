// The single source of truth for every derived id and platform domain. Both the resolver and the core
// handle constructor (App.environments) import these, so the ids they produce cannot drift. Platform
// ids are role-based and host-scoped (shared per host); repo/deployment ids are app-scoped.

export const forgejoId = (hostId: string): string => `${hostId}-git`;
export const runnerId = (hostId: string): string => `${forgejoId(hostId)}-runner`;
export const komodoId = (hostId: string): string => `${hostId}-deploy`;
export const tunnelId = (hostId: string): string => `${hostId}-tunnel`;
// The human-facing Cloudflare tunnel name (must be stable + unique within the account).
export const tunnelName = (hostId: string): string => `intentic-${hostId}`;
export const repoId = (appId: string): string => `${appId}-repo`;
// Forgejo identities are host-scoped (one Forgejo per host), keyed off the author's user/team id. A team is a
// Forgejo org (named by the team id) with one team inside it.
export const forgejoUserId = (hostId: string, userId: string): string => `${forgejoId(hostId)}-user-${userId}`;
export const forgejoOrgId = (hostId: string, teamId: string): string => `${forgejoId(hostId)}-org-${teamId}`;
export const forgejoTeamId = (hostId: string, teamId: string): string => `${forgejoOrgId(hostId, teamId)}-team`;
// The Komodo UI account per declared user, host-scoped like Komodo itself.
export const komodoUserId = (hostId: string, userId: string): string => `${komodoId(hostId)}-user-${userId}`;
// The Forgejo org login a team maps to (the repo + registry namespace for the apps it owns). The team id is
// already globally unique (the builder's claim()), and Forgejo org names must be unique per instance, so the
// team id IS the org name.
export const orgName = (teamId: string): string => teamId;
// The env var key for a user's intentic-generated login password (one per user, reused for Forgejo + Komodo).
export const userPasswordKey = (userId: string): string => `INTENTIC_USER_PASSWORD_${userId.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;
export const deploymentId = (appId: string, environment: string): string => `${appId}.${environment}`;
// The CI/CD wiring node per environment: a Forgejo Actions workflow + repo secrets, keyed off the deployment.
export const ciId = (appId: string, environment: string): string => `${deploymentId(appId, environment)}-ci`;
// CI/CD notification sinks, app-scoped: a Forgejo repo webhook and a Komodo alerter targeting Discord.
export const forgejoNotifyId = (appId: string): string => `${repoId(appId)}-notify`;
export const komodoNotifyId = (appId: string): string => `${appId}-notify`;
export const gitDomain = (zone: string): string => `git.${zone}`;
export const komodoDomain = (zone: string): string => `komodo.${zone}`;
// A deterministic host port per deployment so co-located environments don't collide. Resolver-owned so the
// tunnel's ingress (hostname -> http://<internalIp>:<port>) can be computed without depending on the
// deployment node — which is what lets the tunnel come up before the control plane uses it.
export const deploymentPort = (deploymentId: string): number =>
    20000 + [...deploymentId].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) % 10000, 7);
// The single admin identity for both Forgejo and Komodo — also the repo owner namespace and the Komodo
// build's git account. NOT "admin": Forgejo reserves that name (it collides with the /admin route), so
// `forgejo admin user create --username admin` fails.
export const adminUsername = "intentic";
// The Forgejo built-in container registry authority. Addressed host-locally so the CI runner (push,
// --network host) and Komodo Periphery (pull, host docker socket) both reach Forgejo on the SAME host
// dockerd, which trusts 127.0.0.0/8 registries as insecure-by-default — no daemon.json change needed, and it
// sidesteps that git.<zone> does not resolve inside the host. The dotted loopback IP (NOT "localhost") is
// deliberate: Komodo's image-reference parser only treats a dotted host[:port] first segment as a registry —
// it does not honor Docker's `localhost` special-case — so a `localhost:3000/...` image resolves to docker.io
// and misses this account ("did not find token ... domain docker.io"). The port mirrors Forgejo's HTTP port.
export const registryAuthority = "127.0.0.1:3000";
