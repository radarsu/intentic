import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type Script, type ScriptRun, ScriptRunSchema, ScriptSchema } from "@intentic/sandbox-contract";
import { z } from "zod";

// The workspace's runnable-scripts manifest (<workspace>/.intentic/scripts.json) plus the daemon-owned run
// history (<workspace>/.intentic/script-runs.json). The manifest is files-only user config — the agent or the
// file editor writes it, the daemon only reads it — so the two live in SEPARATE files: daemon run records must
// never fight a hand edit to scripts.json.

// Same cap as automations — enough for the UI's history without the file growing forever.
const RUNS_KEPT = 20;

const RunRecordSchema = z.object({ id: z.string(), runs: z.array(ScriptRunSchema) });
type RunRecord = z.infer<typeof RunRecordSchema>;

// The parsed manifest. scripts.json is hand-authored, so parse failures surface as `manifestError` (the UI says
// "fix the manifest") instead of the silent [] the daemon-owned stores use.
export interface ScriptsManifest {
    readonly scripts: Script[];
    readonly manifestError?: string;
}

export interface ScriptsStore {
    readonly manifest: () => Promise<ScriptsManifest>;
    // All recorded runs keyed by script id (the list join); ids no longer in the manifest simply never render.
    readonly allRuns: () => Promise<Record<string, ScriptRun[]>>;
    // Prepend newest-first, capped at RUNS_KEPT; creates the record when the id has never run.
    readonly recordRun: (id: string, run: ScriptRun) => Promise<void>;
}

export const fileScriptsStore = (manifestPath: string, runsPath: string): ScriptsStore => {
    const readManifest = async (): Promise<ScriptsManifest> => {
        let raw: string;
        try {
            raw = await readFile(manifestPath, "utf8");
        } catch {
            // Missing file = a fresh workspace with no scripts yet, not an authoring mistake.
            return { scripts: [] };
        }
        let value: unknown;
        try {
            value = JSON.parse(raw);
        } catch (error) {
            return { scripts: [], manifestError: `scripts.json is not valid JSON: ${(error as Error).message}` };
        }
        const parsed = z.array(ScriptSchema).safeParse(value);
        if (!parsed.success) {
            const issue = parsed.error.issues[0];
            return { scripts: [], manifestError: `scripts.json is invalid at ${issue.path.join(".") || "root"}: ${issue.message}` };
        }
        const ids = new Set<string>();
        for (const script of parsed.data) {
            if (ids.has(script.id)) {
                return { scripts: [], manifestError: `scripts.json has a duplicate script id "${script.id}"` };
            }
            ids.add(script.id);
        }
        return { scripts: parsed.data };
    };

    // The runs file is daemon-owned, so a corrupt read IS safely an empty history (the automations precedent).
    const readRuns = async (): Promise<RunRecord[]> => {
        try {
            const parsed = z.array(RunRecordSchema).safeParse(JSON.parse(await readFile(runsPath, "utf8")));
            return parsed.success ? parsed.data : [];
        } catch {
            return [];
        }
    };
    const writeRuns = async (records: RunRecord[]): Promise<void> => {
        await mkdir(dirname(runsPath), { recursive: true });
        await writeFile(runsPath, `${JSON.stringify(records, undefined, 2)}\n`);
    };

    return {
        manifest: readManifest,
        allRuns: async () => Object.fromEntries((await readRuns()).map((record) => [record.id, record.runs])),
        recordRun: async (id, run) => {
            const records = await readRuns();
            const existing = records.find((record) => record.id === id);
            const runs = [run, ...(existing?.runs ?? [])].slice(0, RUNS_KEPT);
            await writeRuns([...records.filter((record) => record.id !== id), { id, runs }]);
        },
    };
};
