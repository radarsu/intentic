import type { ResourceType } from "@intentic/resources";
import type { Providers } from "./provider.js";
import type { ReadinessProbe } from "./readiness.js";

// Inputs after $secret/$ref substitution: still a value tree, but with no $ref/$secret nodes left.
// A bare ref becomes the dependency's id string; an output ref becomes its resolved value.
export type ResolvedInputs = Readonly<Record<string, unknown>>;

export type Action = "create" | "update" | "noop";

export interface Step {
    readonly id: string;
    readonly type: ResourceType;
    readonly action: Action;
    readonly reason?: string; // present for "update"
}

export interface Orphan {
    readonly id: string;
    readonly type: ResourceType;
}

export interface PlanOutcome {
    readonly steps: readonly Step[];
    readonly orphans: readonly Orphan[];
}

export interface ApplyOutcome {
    readonly steps: readonly Step[];
    readonly outputs: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
    readonly orphans: readonly Orphan[];
}

export interface EngineConfig {
    readonly providers: Providers;
    readonly env?: Readonly<Record<string, string | undefined>>; // default: process.env
    readonly probe?: ReadinessProbe; // default: httpProbe
    readonly log?: (message: string) => void; // default: console.log
}
