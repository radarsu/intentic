import type { DesiredStateGraph } from "@intentic/graph";
import { linearize, refKey } from "@intentic/graph";
import type { ResourceType } from "@intentic/resources";
import { OUTPUTS } from "@intentic/resources";
import { resolveInputs } from "../resolve-inputs.js";
import { createStore, type OutputStore, PENDING } from "../store.js";
import type { EngineConfig, PrunedResource, PruneOutcome } from "../types.js";
import { makeContext, requireProvider } from "./reconcile.js";

// A read pass over the CURRENT (kept) graph that seeds `store` with each kept node's live outputs (PENDING
// for any not-yet-created node), mirroring plan.ts's seeding. A removed node's inputs reference kept platform
// nodes (cloudflare.zoneId, komodo.internalUrl, ...); those must resolve so its provider's `delete` can reach
// the API it tears the resource down through.
const seedCurrentOutputs = async (graph: DesiredStateGraph, config: EngineConfig, store: OutputStore): Promise<void> => {
    const env = config.env ?? process.env;
    const log = config.log ?? console.log;
    for (const id of linearize(graph)) {
        const node = graph.resources[id];
        if (node === undefined) {
            continue;
        }
        const type = node.type as ResourceType;
        const provider = requireProvider(config.providers, type, id);
        const ctx = makeContext(id, store, env, log);
        const inputs = resolveInputs(node.inputs, store, env, { lenient: true });
        const observed = await provider.read(inputs, ctx);
        store.set(id, id);
        if (observed === undefined) {
            for (const name of OUTPUTS[type]) {
                store.set(refKey(id, name), PENDING);
            }
            continue;
        }
        for (const [name, value] of Object.entries(observed.outputs)) {
            if (OUTPUTS[type].includes(name)) {
                store.set(refKey(id, name), value);
            }
        }
    }
};

// Converge by deletion: tear down every resource present in the last successfully-applied (`previous`) graph
// but absent from the new (`current`) one. Deletes run in REVERSE dependency order (dependents before their
// dependencies) using each removed node's PREVIOUS resolved inputs. A removed type whose provider has no
// `delete` is left in place and logged (converge-forward, like orphan reporting). Idempotent: a provider's
// `delete` may find the resource already gone.
export const prune = async (previous: DesiredStateGraph, current: DesiredStateGraph, config: EngineConfig): Promise<PruneOutcome> => {
    const env = config.env ?? process.env;
    const log = config.log ?? console.log;
    const emit = config.onEvent ?? (() => {});
    const kept = new Set(Object.keys(current.resources));
    const removed = new Set(Object.keys(previous.resources).filter((id) => !kept.has(id)));
    if (removed.size === 0) {
        return { deleted: [], skipped: [] };
    }

    const store = createStore();
    await seedCurrentOutputs(current, config, store);

    const deleted: PrunedResource[] = [];
    const skipped: PrunedResource[] = [];
    for (const id of [...linearize(previous)].toReversed()) {
        if (!removed.has(id)) {
            continue;
        }
        const node = previous.resources[id];
        if (node === undefined) {
            continue;
        }
        const type = node.type as ResourceType;
        const provider = requireProvider(config.providers, type, id);
        if (provider.delete === undefined) {
            emit({ kind: "prune", state: "skipped", id, type });
            skipped.push({ id, type });
            continue;
        }
        const ctx = makeContext(id, store, env, log);
        const inputs = resolveInputs(node.inputs, store, env, { lenient: true });
        await provider.delete(inputs, ctx);
        emit({ kind: "prune", state: "deleted", id, type });
        deleted.push({ id, type });
    }
    return { deleted, skipped };
};
