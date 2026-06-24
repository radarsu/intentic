import type { DesiredStateGraph } from "@intentic/graph";
import type { IntentSet } from "@intentic/need-resolver";
import { resolveState } from "@intentic/state-resolver";
import type { Stack } from "./handles.js";
import { createStack } from "./stack.js";

// The authoring entry — "what you want": run the declaration and capture it as an IntentSet. `intentic
// resolve` runs the resolvers (intent → needs → desired state) over it.
export const defineIntent = (declare: (stack: Stack) => void): IntentSet => {
    const { stack, intent } = createStack();
    declare(stack);
    return intent;
};

// One-shot: intent → needs → the desired-state graph the resolvers derive.
export const defineStack = (declare: (stack: Stack) => void): DesiredStateGraph => resolveState(defineIntent(declare));

export type { App, Cloudflare, Deployment, Have, Host, Repo, Stack, Want, WantAppInput } from "./handles.js";
