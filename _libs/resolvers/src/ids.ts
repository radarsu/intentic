// The single source of truth for every derived id and platform domain. Both the resolver and the core
// handle constructor (App.environments) import these, so the ids they produce cannot drift. Platform
// ids are role-based and host-scoped (shared per host); repo/deployment ids are app-scoped.

export const forgejoId = (hostId: string): string => `${hostId}-git`;
export const runnerId = (hostId: string): string => `${forgejoId(hostId)}-runner`;
export const komodoId = (hostId: string): string => `${hostId}-deploy`;
export const tunnelId = (hostId: string): string => `${hostId}-tunnel`;
// The human-facing Cloudflare tunnel name (must be stable + unique within the account).
export const tunnelName = (hostId: string): string => `puristic-${hostId}`;
export const repoId = (appId: string): string => `${appId}-repo`;
export const deploymentId = (appId: string, environment: string): string => `${appId}.${environment}`;
export const gitDomain = (zone: string): string => `git.${zone}`;
export const komodoDomain = (zone: string): string => `komodo.${zone}`;
