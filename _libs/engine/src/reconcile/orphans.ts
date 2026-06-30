import type { DesiredStateGraph } from "@intentic/graph";
import type { ResourceType } from "@intentic/resources";
import type { ProviderContext, Providers } from "../provider.js";
import type { EngineEvent, Orphan } from "../types.js";

// Converge-forward: stamped resources whose id is absent from the desired graph are reported (as an
// event), never deleted. Requires a provider to expose `list`; providers without it are skipped.
export const collectOrphans = async (
    graph: DesiredStateGraph,
    providers: Providers,
    ctx: ProviderContext,
    emit: (event: EngineEvent) => void,
): Promise<Orphan[]> => {
    const known = new Set(Object.keys(graph.resources));
    const orphans: Orphan[] = [];
    for (const [type, provider] of Object.entries(providers)) {
        if (provider?.list === undefined) {
            continue;
        }
        for (const id of await provider.list(ctx)) {
            if (!known.has(id)) {
                emit({ kind: "orphan", id, type: type as ResourceType });
                orphans.push({ id, type: type as ResourceType });
            }
        }
    }
    return orphans;
};
