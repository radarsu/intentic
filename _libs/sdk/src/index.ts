import type { DesiredStateGraph } from "@intentic/graph";
import type { IntentSet } from "@intentic/resolvers";
import { choose, generateCandidates } from "@intentic/resolvers";
import type { Stack } from "./handles.js";
import { createStack } from "./stack.js";

// The authoring entry — "what you want": run the declaration and capture it as an IntentSet. `intentic
// resolve` turns this into candidates (needs → options → candidates) and chooses one.
export const defineIntent = (declare: (stack: Stack) => void): IntentSet => {
    const { stack, intent } = createStack();
    declare(stack);
    return intent;
};

// One-shot: intent -> every candidate -> choose one -> its desired-state graph. `preferKey` selects a
// specific candidate; absent, the deterministic auto-pick (first candidate) wins.
export const defineStack = (declare: (stack: Stack) => void, preferKey?: string): DesiredStateGraph =>
    choose(generateCandidates(defineIntent(declare)), preferKey).graph;

export type { App, Deployment, Repo, Stack, Want, WantAppInput } from "./handles.js";
