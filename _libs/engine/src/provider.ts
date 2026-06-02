import type { ResourceType } from "@puristic/deploy-resolvers";
import type { ResolvedInputs } from "./types.js";

// A resource that exists in actual infrastructure, recovered statelessly by its ownership stamp/id.
export interface Observed {
    readonly outputs: Readonly<Record<string, unknown>>;
}

// A pure diff decision: noop, or update with a human-readable reason (surfaced in plan output).
export type DiffResult = { readonly action: "noop" } | { readonly action: "update"; readonly reason: string };

export interface ProviderContext {
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly log: (message: string) => void;
    // The id of the node currently being reconciled — what a provider stamps its resource with.
    readonly id: string;
    // A dependency's produced output. Used on the BARE-ref path: an input that is a bare {$ref:"dep"}
    // resolves to the id string "dep", and the provider reaches the dep's real outputs here. Throws if
    // (id, name) was not produced this run.
    readonly output: (id: string, name: string) => unknown;
}

// The contract every provider implements. `apply` (create-or-update) is provider-owned and distinct
// from the engine's top-level apply(); it reads as `provider.apply(...)`.
export interface Provider {
    // Stateless introspection: the resource stamped with `id`, or undefined if it does not exist.
    readonly read: (id: string, ctx: ProviderContext) => Promise<Observed | undefined>;
    // Pure decision (no mutation). The engine calls this ONLY when `read` returned an Observed.
    readonly diff: (inputs: ResolvedInputs, observed: Observed) => DiffResult;
    // Mutating: create (observed === undefined) or update. Returns the resource's produced outputs.
    readonly apply: (inputs: ResolvedInputs, observed: Observed | undefined, ctx: ProviderContext) => Promise<Record<string, unknown>>;
    // Optional: stamped ids of this kind that exist in infra, for orphan detection.
    readonly list?: (ctx: ProviderContext) => Promise<readonly string[]>;
}

// A node whose `type` has no registered provider is a hard error at reconcile time.
export type Providers = Partial<Record<ResourceType, Provider>>;
