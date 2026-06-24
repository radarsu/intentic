import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Candidate } from "@intentic/resolvers";
import { configFileName } from "./controller.js";

// The default intent evaluator runController injects: write the pushed deploy.config.ts to a temp module
// and import it (Node strips the types), expecting it to export `candidates` (from defineCandidates) — the
// set of reconciliation-target artifacts to choose from. This is the environment-specific seam; a
// sandboxed evaluator can replace it. Resolving the config's @intentic/* imports requires those packages
// to be resolvable from the evaluator's process.
export const evaluateIntentSource = async (source: string): Promise<readonly Candidate[]> => {
    const dir = await mkdtemp(join(tmpdir(), "intentic-intent-"));
    const file = join(dir, configFileName);
    try {
        await writeFile(file, source);
        const loaded = (await import(pathToFileURL(file).href)) as { candidates?: readonly Candidate[] };
        if (loaded.candidates === undefined) {
            throw new Error(`${configFileName} must export "candidates" (from defineCandidates)`);
        }
        return loaded.candidates;
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
};
