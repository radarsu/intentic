import type { CloudflareInput, EnvironmentInput, HostInput, NotifyInput } from "./inputs.js";

// The intent the builder records and the resolver consumes — "what you have" + "what you want" as pure
// data. App `on`/`expose` are resource-id strings (not handles), so the intent stays serializable and
// depends on nothing from the authoring layer. There is a single host and a single Cloudflare account.

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

// host/cloudflare are optional so an app-less intent stays valid; the SDK's `on`/`expose` types guarantee
// both are declared whenever an app is, and the resolver asserts the same before deriving anything.
export interface IntentSet {
    readonly host?: HostIntent;
    readonly cloudflare?: CloudflareIntent;
    readonly apps: readonly AppIntent[];
}
