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
