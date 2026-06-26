import type { Input, Readiness, SecretRef } from "@intentic/graph";

// The author-supplied data shapes. They reference only protocol primitives so the intent that carries
// them stays free of any dependency on the authoring handles.

// The host an app runs on: its SSH connection, authored inline. address/user are literals; the private
// key is a secret. SSH port defaults to 22 when omitted.
export interface HostInput {
    address: string;
    user: string;
    sshKey: SecretRef;
    port?: number;
}

// The Cloudflare account an app is exposed through. Only the API token is authored: the zone is discovered
// from the token (the authored domains pick which of the token's zones to use) and the owning account is
// resolved from that zone, so neither is declared here.
export interface CloudflareInput {
    apiToken: SecretRef;
}

export interface EnvironmentInput {
    domain: string;
    branch: string;
    env?: Record<string, Input<string>>;
    readyWhen?: Readiness;
}

// Author-supplied CI/CD notification sinks. A write-only webhook secret; the resolver derives the
// Forgejo repo webhook (CI) and Komodo alerter (CD) that target it. Absent = no notifications.
export interface NotifyInput {
    discord: SecretRef;
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
