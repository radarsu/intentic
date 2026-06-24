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

// The Cloudflare account an app is exposed through: account id + zone are literals (the zone's hostnames
// are baked into the derived graph), the API token is a secret.
export interface CloudflareInput {
    accountId: string;
    apiToken: SecretRef;
    zone: string;
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
