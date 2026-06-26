import type { Input, Readiness, SecretRef } from "@intentic/graph";

// The author-supplied data shapes. They reference only protocol primitives so the intent that carries
// them stays free of any dependency on the authoring handles.

// How image-pin bumps roll out on this host. "pinned" (default): recreate the service on the new pin and
// health-gate (Phase-1 behavior); rollback is `git revert` + re-apply. "guarded": wrap each stateful
// service's bump in a transaction — pre-update restic snapshot, recreate, health-gate, and auto-rollback
// (old image + restored data) on failure. "guarded" requires i.have.backup (it reuses its restic repo).
export type UpdatePolicy = "pinned" | "guarded";

// The host an app runs on: its SSH connection, authored inline. address/user are literals; the private
// key is a secret. SSH port defaults to 22 when omitted.
export interface HostInput {
    address: string;
    user: string;
    sshKey: SecretRef;
    port?: number;
    updatePolicy?: UpdatePolicy;
}

// The Cloudflare account an app is exposed through. Only the API token is authored: the zone is discovered
// from the token (the authored domains pick which of the token's zones to use) and the owning account is
// resolved from that zone, so neither is declared here.
export interface CloudflareInput {
    apiToken: SecretRef;
}

// A GitHub account the apps are sourced through: repos, CI (GitHub Actions), and container registry (GHCR).
// The PAT authenticates every API call; `owner` defaults to the token's authenticated user when omitted.
export interface GitHubInput {
    token: SecretRef;
    owner?: string;
}

export interface EnvironmentInput {
    domain: string;
    branch: string;
    env?: Record<string, Input<string>>;
    readyWhen?: Readiness;
}

// The Discord bot token intentic uses to own the back-communication channel. intentic creates and
// manages the guild, categories, channels, and webhooks; the user supplies only the bot token.
// Absent = no Discord integration (no CI/CD notifications, no reconcile summaries).
export interface DiscordInput {
    botToken: SecretRef;
}

// How long restic keeps snapshots before `forget --prune` drops them. Omitted fields fall back to the
// provider's defaults (7 daily / 4 weekly / 6 monthly).
export interface BackupRetention {
    daily?: number;
    weekly?: number;
    monthly?: number;
}

// The backup destination the operator provides: a restic repository plus the secrets to reach + decrypt it.
// `repo` is a restic repo URL (s3:…, b2:…, sftp:…, rest:…). `password` is the restic encryption password.
// `credentials` are the backend's access keys (e.g. AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, B2_ACCOUNT_ID/…),
// keyed by the env var restic expects. `schedule` is a cron expression (default daily at 03:00). `signoz`
// opts the (large, reconstructable) observability volumes into the backup set; off by default.
export interface BackupInput {
    repo: string;
    password: SecretRef;
    credentials?: Record<string, SecretRef>;
    schedule?: string;
    retention?: BackupRetention;
    signoz?: boolean;
}

// An off-the-shelf shared service the host runs, named by `kind` from the service catalog. Unlike apps
// (built from source through the platform), a service is deployed directly onto the host from a pinned
// image and exposed at its own `domain`. Today's catalog: SignOz (observability).
export type ServiceKind = "signoz";

export interface ServiceInput {
    kind: ServiceKind;
    domain: string;
}

// A person who works on the apps: a real Forgejo git account + a Komodo UI user. The login password is
// intentic-generated (one per user, reused for both logins), so it is not authored here.
export interface UserInput {
    username: string;
    email: string;
}

// A team of users. Becomes a Forgejo organization (named by the team id) + a team inside it, and grants its
// members a single Komodo permission level on the deployments of the apps the team is attached to. `members`
// are user ids (i.want.user); the intent stays a serializable id graph, like AppIntent.on/expose.
export type ForgejoRole = "admin" | "write" | "read";
export type KomodoRole = "admin" | "execute" | "read";

export interface TeamInput {
    members: readonly string[];
    komodo: KomodoRole;
}

// An app's grant of a team at a Forgejo role. `team` is a team id. The first grant on an app owns its repo
// (its org is the repo + registry namespace); the rest are added as collaborator teams at their role.
export interface AppTeamGrantInput {
    team: string;
    role: ForgejoRole;
}
