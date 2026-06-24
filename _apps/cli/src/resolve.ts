import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { IntentSet } from "@intentic/resolvers";

// Load the intent a deploy.config.ts exports by importing it IN PLACE — so its `@intentic/sdk` and
// `@intentic/graph` imports resolve from the project the config lives in (Node strips the TS types).
// The resolver turns this intent into candidates at resolve time.
export const loadIntent = async (configPath: string): Promise<IntentSet> => {
    const loaded = (await import(pathToFileURL(resolve(configPath)).href)) as { intent?: IntentSet };
    if (loaded.intent === undefined) {
        throw new Error(`${configPath} must export "intent" (from defineIntent)`);
    }
    return loaded.intent;
};
