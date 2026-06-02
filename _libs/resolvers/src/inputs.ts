import type { Input, Readiness, SecretRef } from "@puristic/deploy-protocol";

// The author-supplied data shapes. They reference only protocol primitives so the intent that carries
// them stays free of any dependency on the authoring handles.

export interface HostInput {
    address: string;
    user: string;
    sshKey: SecretRef;
    port?: number;
}

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
