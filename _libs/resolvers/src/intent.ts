import type { CloudflareInput, EnvironmentInput, HostInput, NotifyInput } from "./inputs.js";

// The intent the builder records and the resolver consumes — "what you have" + "what you want" as pure
// data. App `on`/`expose` are resource-id strings (not handles), so the intent stays serializable and
// depends on nothing from the authoring layer.

export interface HostIntent {
    readonly id: string;
    readonly input: HostInput;
}

export interface CloudflareIntent {
    readonly id: string;
    readonly input: CloudflareInput;
}

export interface AppIntent {
    readonly id: string;
    readonly on: string;
    readonly expose: string;
    readonly notify?: NotifyInput;
    readonly environments: Readonly<Record<string, EnvironmentInput>>;
}

export interface IntentSet {
    readonly hosts: readonly HostIntent[];
    readonly clouds: readonly CloudflareIntent[];
    readonly apps: readonly AppIntent[];
}
