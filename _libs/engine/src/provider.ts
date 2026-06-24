import type { ResourceType } from "@intentic/resources";
import type { ResolvedInputs } from "./types.js";

// A resource that exists in actual infrastructure, recovered statelessly by its ownership stamp/id.
export interface Observed {
    readonly outputs: Readonly<Record<string, unknown>>;
    // Provider-private introspection the engine never validates against OUTPUTS and never stores as refs
    // — only diff reads it. Lets a provider surface actual config (e.g. a tunnel's current ingress) so a
    // pure diff can detect drift, which outputs cannot carry (validateOutputs rejects undeclared keys).
    readonly detail?: Readonly<Record<string, unknown>>;
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
    // Stateless introspection of the node being reconciled (its id is on ctx.id, its inputs are passed
    // in), returning the resource if it exists or undefined if it does not. In plan mode `inputs` may
    // carry PENDING values for dependencies that are themselves pending creates; a provider that cannot
    // introspect from such inputs must return undefined.
    readonly read: (inputs: ResolvedInputs, ctx: ProviderContext) => Promise<Observed | undefined>;
    // Pure decision (no mutation). The engine calls this ONLY when `read` returned an Observed.
    readonly diff: (inputs: ResolvedInputs, observed: Observed) => DiffResult;
    // Mutating: create (observed === undefined) or update. Returns the resource's produced outputs.
    readonly apply: (inputs: ResolvedInputs, observed: Observed | undefined, ctx: ProviderContext) => Promise<Record<string, unknown>>;
    // Optional: stamped ids of this kind that exist in infra, for orphan detection.
    readonly list?: (ctx: ProviderContext) => Promise<readonly string[]>;
}

// A node whose `type` has no registered provider is a hard error at reconcile time.
export type Providers = Partial<Record<ResourceType, Provider>>;
