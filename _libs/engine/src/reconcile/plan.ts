import type { DesiredStateGraph } from "@intentic/graph";
import { linearize, refKey } from "@intentic/graph";
import type { ResourceType } from "@intentic/resources";
import { OUTPUTS } from "@intentic/resources";
import { resolveInputs } from "../resolve-inputs.js";
import { createStore, PENDING } from "../store.js";
import type { EngineConfig, PlanOutcome, Step } from "../types.js";
import { collectOrphans } from "./orphans.js";
import { makeContext, requireProvider } from "./reconcile.js";

// Dry run: read actual state and decide create/update/noop per node WITHOUT mutating. Existing resources
// seed the store from their real observed outputs; pending creates seed PENDING, so a dependent's lenient
// resolution never throws. A real diff only ever runs for an already-existing resource (whose deps also
// exist and resolve to real values), so PENDING can never reach a diff.
export const plan = async (graph: DesiredStateGraph, config: EngineConfig): Promise<PlanOutcome> => {
    const env = config.env ?? process.env;
    const log = config.log ?? console.log;
    const emit = config.onEvent ?? (() => {});
    const store = createStore();
    const steps: Step[] = [];

    for (const id of linearize(graph)) {
        const node = graph.resources[id];
        if (node === undefined) {
            continue;
        }
        const type = node.type as ResourceType;
        const provider = requireProvider(config.providers, type, id);
        const ctx = makeContext(id, store, env, log);
        // Resolve leniently before read: a dependency that is itself a pending create has no real output
        // yet, so its ref resolves to PENDING rather than throwing. read must tolerate that (and return
        // undefined if it cannot introspect); the same inputs feed diff for an existing resource.
        const inputs = resolveInputs(node.inputs, store, env, { lenient: true });
        const observed = await provider.read(inputs, ctx);

        store.set(id, id);
        if (observed === undefined) {
            steps.push({ id, type, action: "create" });
            emit({ kind: "node", phase: "plan", state: "done", id, type, action: "create" });
            for (const name of OUTPUTS[type]) {
                if (name.endsWith(":")) {
                    // Prefix pattern: seed PENDING for every actual $ref in the graph that matches.
                    const prefix = `${id}.${name}`;
                    for (const node of Object.values(graph.resources)) {
                        JSON.stringify(node.inputs, (_k, v) => {
                            if (typeof v === "object" && v !== null && "$ref" in v && typeof v.$ref === "string" && v.$ref.startsWith(prefix)) {
                                store.set(v.$ref as string, PENDING);
                            }
                            return v;
                        });
                    }
                } else {
                    store.set(refKey(id, name), PENDING);
                }
            }
            continue;
        }

        const result = provider.diff(inputs, observed);
        steps.push(result.action === "update" ? { id, type, action: "update", reason: result.reason } : { id, type, action: "noop" });
        emit(
            result.action === "update"
                ? { kind: "node", phase: "plan", state: "done", id, type, action: "update", reason: result.reason }
                : { kind: "node", phase: "plan", state: "done", id, type, action: "noop" },
        );
        for (const [name, value] of Object.entries(observed.outputs)) {
            const allowed = OUTPUTS[type].some((pattern) => (pattern.endsWith(":") ? name.startsWith(pattern) : name === pattern));
            if (allowed) {
                store.set(refKey(id, name), value);
            }
        }
    }

    const orphans = await collectOrphans(graph, config.providers, makeContext("", store, env, log), emit);
    return { steps, orphans };
};
