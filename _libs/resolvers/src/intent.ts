import type { EnvironmentInput, NotifyInput } from "./inputs.js";

// The intent the builder records and the resolver consumes — "what you want" as pure data. The host and
// Cloudflare an app runs on/through are no longer authored: they are the implicit reconciled inventory
// (see inventory.ts), so the intent carries only apps and stays free of any infra config or secrets.

export interface AppIntent {
    readonly id: string;
    readonly notify?: NotifyInput;
    readonly environments: Readonly<Record<string, EnvironmentInput>>;
}

export interface IntentSet {
    readonly apps: readonly AppIntent[];
}
