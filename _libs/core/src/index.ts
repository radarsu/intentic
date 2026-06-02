import type { DesiredStateGraph } from "@puristic/deploy-protocol";
import { compile, toNodeMap } from "@puristic/deploy-protocol";
import type { IntentSet } from "@puristic/deploy-resolvers";
import { resolve } from "@puristic/deploy-resolvers";
import type { Stack } from "./handles.js";
import { createStack } from "./stack.js";

// Layer 1 — "what you have" + "what you want": run the declaration and capture it as an IntentSet.
export const build = (declare: (stack: Stack) => void): IntentSet => {
    const { stack, intent } = createStack();
    declare(stack);
    return intent;
};

// One-shot: build (have + want) -> resolve (what that requires) -> compile (the desired-state graph).
export const defineStack = (declare: (stack: Stack) => void): DesiredStateGraph => compile(toNodeMap(resolve(build(declare))));

export type { App, Cloudflare, Deployment, Have, Host, Repo, Stack, Want, WantAppInput } from "./handles.js";
