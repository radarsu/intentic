import type { AppTeamGrantInput, CloudflareInput, EnvironmentInput, HostInput, NotifyInput, ServiceInput, TeamInput, UserInput } from "./inputs.js";

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

export interface UserIntent {
    readonly id: string;
    readonly input: UserInput;
}

export interface TeamIntent {
    readonly id: string;
    readonly input: TeamInput;
}

export interface AppIntent {
    readonly id: string;
    readonly on: string;
    readonly expose: string;
    readonly notify?: NotifyInput;
    // The id of a service (i.want.service) this app sends telemetry to. The resolver injects that service's
    // OTLP endpoint into each deployment's env and depends the deployment on it. Absent = no telemetry.
    readonly observe?: string;
    // The teams that manage this app, each at a Forgejo role. The first grant's team owns the repo; absent or
    // empty = admin-owned (the default single-admin behaviour). Resolver validates each team is declared.
    readonly teams?: readonly AppTeamGrantInput[];
    readonly environments: Readonly<Record<string, EnvironmentInput>>;
}

// A shared off-the-shelf service the author wants: a catalog `kind` deployed onto a host (`on`) and exposed
// through a Cloudflare account (`expose`). Like AppIntent, `on`/`expose` are resource-id strings.
export interface ServiceIntent extends ServiceInput {
    readonly id: string;
    readonly on: string;
    readonly expose: string;
}

// host/cloudflare are optional so an app-less intent stays valid; the SDK's `on`/`expose` types guarantee
// both are declared whenever an app or service is, and the resolver asserts the same before deriving.
export interface IntentSet {
    readonly host?: HostIntent;
    readonly cloudflare?: CloudflareIntent;
    readonly users: readonly UserIntent[];
    readonly teams: readonly TeamIntent[];
    readonly apps: readonly AppIntent[];
    readonly services: readonly ServiceIntent[];
}
