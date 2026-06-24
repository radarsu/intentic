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
export const deploymentId = (appId: string, environment: string): string => `${appId}.${environment}`;
// CI/CD notification sinks, app-scoped: a Forgejo repo webhook and a Komodo alerter targeting Discord.
export const forgejoNotifyId = (appId: string): string => `${repoId(appId)}-notify`;
export const komodoNotifyId = (appId: string): string => `${appId}-notify`;
// Push-to-deploy: a Forgejo repo webhook per environment that hits Komodo's deploy listener on push.
export const deployHookId = (appId: string, environment: string): string => `${deploymentId(appId, environment)}-deploy-hook`;
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
