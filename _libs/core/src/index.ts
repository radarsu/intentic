import type { DesiredStateGraph } from "@puristic/deploy-protocol";
import type { Candidate, IntentSet } from "@puristic/deploy-resolvers";
import { choose, generateCandidates } from "@puristic/deploy-resolvers";
import type { Stack } from "./handles.js";
import { createStack } from "./stack.js";

// Layer 1 — "what you have" + "what you want": run the declaration and capture it as an IntentSet.
export const build = (declare: (stack: Stack) => void): IntentSet => {
    const { stack, intent } = createStack();
    declare(stack);
    return intent;
};

// Layer 2 — "what that requires", as every valid option combination: build (have + want) -> generate the
// set of candidate reconciliation-target artifacts. The controller presents these for choice.
export const defineCandidates = (declare: (stack: Stack) => void): Candidate[] => generateCandidates(build(declare));

// One-shot: build -> generate candidates -> choose one -> its desired-state graph. `preferKey` selects a
// specific candidate; absent, the deterministic auto-pick (first candidate) wins.
export const defineStack = (declare: (stack: Stack) => void, preferKey?: string): DesiredStateGraph =>
    choose(defineCandidates(declare), preferKey).graph;

export type { App, Cloudflare, Deployment, Have, Host, Repo, Stack, Want, WantAppInput } from "./handles.js";
