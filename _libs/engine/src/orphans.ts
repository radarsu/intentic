import type { DesiredStateGraph } from "@intentic/graph";
import type { ResourceType } from "@intentic/resolvers";
import type { ProviderContext, Providers } from "./provider.js";
import type { Orphan } from "./types.js";

// Converge-forward: stamped resources whose id is absent from the desired graph are reported (and
// logged), never deleted. Requires a provider to expose `list`; providers without it are skipped.
export const collectOrphans = async (graph: DesiredStateGraph, providers: Providers, ctx: ProviderContext): Promise<Orphan[]> => {
    const known = new Set(Object.keys(graph.resources));
    const orphans: Orphan[] = [];
    for (const [type, provider] of Object.entries(providers)) {
        if (provider?.list === undefined) {
            continue;
        }
        for (const id of await provider.list(ctx)) {
            if (!known.has(id)) {
                ctx.log(`orphan: "${id}" (type "${type}") exists but is not in the desired graph — not deleted`);
                orphans.push({ id, type: type as ResourceType });
            }
        }
    }
    return orphans;
};
