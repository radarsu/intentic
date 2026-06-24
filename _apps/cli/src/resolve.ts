import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Candidate } from "@intentic/resolvers";

// Load the candidate artifacts a deploy.config.ts exports by importing it IN PLACE — so its `@intentic/sdk`
// and `@intentic/graph` imports resolve from the project the config lives in (Node strips the TS types).
export const loadCandidates = async (configPath: string): Promise<readonly Candidate[]> => {
    const loaded = (await import(pathToFileURL(resolve(configPath)).href)) as { candidates?: readonly Candidate[] };
    if (loaded.candidates === undefined) {
        throw new Error(`${configPath} must export "candidates" (from defineCandidates)`);
    }
    return loaded.candidates;
};
