import type { Input, Readiness, SecretRef } from "@intentic/graph";

// The author-supplied data shapes. They reference only protocol primitives so the intent that carries
// them stays free of any dependency on the authoring handles.

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
