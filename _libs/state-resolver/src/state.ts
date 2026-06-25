import type { DesiredStateGraph } from "@intentic/graph";
import { compile, toNodeMap } from "@intentic/graph";
import type { IntentSet } from "@intentic/need-resolver";
import { needKey, resolveNeeds } from "@intentic/need-resolver";
import type { Catalog } from "./catalog.js";
import { defaultCatalog } from "./catalog.js";
import { emit } from "./emit.js";

// The state resolver: intent → needs → desired state. It derives the needs, assigns each the catalog option
// that fills its capability, and compiles the emitted nodes into one desired-state graph. Everything is
// determined by the intent — there is no choice to make, so the catalog must offer exactly one option per
// capability (Forgejo fills both source-control and docker-registry, so those needs share it). `zone` is the
// Cloudflare zone the apps are exposed under: the CLI discovers it from the API token before resolving;
// pure callers (tests, fixtures) pass it directly. It is required whenever the intent has apps/services.
export const resolveState = (intent: IntentSet, zone?: string, catalog: Catalog = defaultCatalog): DesiredStateGraph => {
    const byNeed = new Map<string, string>();
    for (const need of resolveNeeds(intent)) {
        const options = catalog.optionsFor(need.capability);
        if (options.length === 0) {
            throw new Error(`no option satisfies "${need.capability}"`);
        }
        if (options.length > 1) {
            throw new Error(`ambiguous: "${need.capability}" has ${options.length} options but the state resolver makes no choice`);
        }
        byNeed.set(needKey(need), (options[0] as { id: string }).id);
    }
    return compile(toNodeMap(emit(intent, { byNeed }, zone)));
};
