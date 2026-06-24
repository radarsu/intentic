import type { DesiredStateGraph } from "@puristic/deploy-protocol";
import { compile, toNodeMap } from "@puristic/deploy-protocol";
import type { Catalog, Option } from "./catalog.js";
import { defaultCatalog } from "./catalog.js";
import { emit } from "./emit.js";
import type { IntentSet } from "./intent.js";
import type { Need } from "./needs.js";
import { deriveNeeds, needKey } from "./needs.js";

// One valid option-per-need selection, before it is built into a graph. `key` is the deduped, sorted
// option ids — a stable identifier for "which combination this is".
export interface AssignmentPlan {
    readonly key: string;
    readonly chosenOptions: Readonly<Record<string, string>>;
    readonly byNeed: ReadonlyMap<string, string>;
}

// One reconciliation-target artifact: an assignment plan compiled into a desired-state graph.
export interface Candidate {
    readonly key: string;
    readonly chosenOptions: Readonly<Record<string, string>>;
    readonly graph: DesiredStateGraph;
}

// Cartesian product of the per-need option choices.
const product = (choices: readonly (readonly Option[])[]): Option[][] => {
    let combos: Option[][] = [[]];
    for (const options of choices) {
        const next: Option[][] = [];
        for (const combo of combos) {
            for (const option of options) {
                next.push([...combo, option]);
            }
        }
        combos = next;
    }
    return combos;
};

// A combo is valid only if every option it picks is also picked for ALL same-scope needs whose capability
// it provides — so a multi-capability option (Forgejo: source-control + docker-registry) is never split
// across two different options.
const isValid = (needs: readonly Need[], chosen: ReadonlyMap<string, Option>): boolean => {
    for (const need of needs) {
        const option = chosen.get(needKey(need));
        if (option === undefined) {
            return false;
        }
        for (const other of needs) {
            if (other.scope === need.scope && option.provides.includes(other.capability) && chosen.get(needKey(other))?.id !== option.id) {
                return false;
            }
        }
    }
    return true;
};

// Every valid option-per-need selection for an intent: derive the needs, look up the options that fill
// each, and keep every valid combination. Today's catalog has one option per need, so there is exactly
// one plan; the structure supports N (e.g. a future Gitlab option yields more).
export const enumerateAssignments = (intent: IntentSet, catalog: Catalog = defaultCatalog): AssignmentPlan[] => {
    const needs = deriveNeeds(intent);
    const choices = needs.map((need) => catalog.optionsFor(need.capability));
    for (const [index, options] of choices.entries()) {
        if (options.length === 0) {
            throw new Error(`no option satisfies "${needs[index]?.capability}"`);
        }
    }

    const plans: AssignmentPlan[] = [];
    for (const combo of product(choices)) {
        const chosen = new Map(needs.map((need, index) => [needKey(need), combo[index] as Option]));
        if (!isValid(needs, chosen)) {
            continue;
        }
        const byNeed = new Map<string, string>();
        const chosenOptions: Record<string, string> = {};
        for (const [key, option] of chosen) {
            byNeed.set(key, option.id);
            chosenOptions[key] = option.id;
        }
        const key = [...new Set(combo.map((option) => option.id))].sort().join("+");
        plans.push({ key, chosenOptions, byNeed });
    }
    return plans;
};

// All candidate reconciliation-target artifacts for an intent: every valid assignment compiled into a
// graph. Only assignments the emitter can build are realizable today (it throws on unsupported options).
export const generateCandidates = (intent: IntentSet, catalog: Catalog = defaultCatalog): Candidate[] =>
    enumerateAssignments(intent, catalog).map((plan) => ({
        key: plan.key,
        chosenOptions: plan.chosenOptions,
        graph: compile(toNodeMap(emit(intent, { byNeed: plan.byNeed }))),
    }));
