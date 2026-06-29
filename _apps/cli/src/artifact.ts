import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DesiredStateGraph } from "@intentic/graph";

// A local workspace is three repos: an `intent` repo (holds the deploy.config.ts a user authors), a
// `desired-state` repo (holds the artifact `resolve` writes and the status `apply` writes beside it), and an
// `app` repo (the application code the agent edits + previews, mounted at /work/app in the sandbox). `init`
// scaffolds all three.
export const INTENT_DIR = "intent";
export const TARGET_DIR = "desired-state";
export const APP_DIR = "app";
export const CONFIG_FILE = "deploy.config.ts";
export const ARTIFACT_FILE = "desired-state.json";
export const LAST_APPLIED_FILE = ".last-applied.json";
export const STATUS_FILE = "status.json";
export const ACCESS_FILE = "access.md";
export const ENV_FILE = ".env";
export const SECRETS_FILE = ".secrets.json";
// The host-key lockfile: each host's pinned public key. Committed (a public key is not secret) so a key
// change is a reviewable diff and the Forgejo CI apply verifies against the reviewed pin.
export const KNOWN_HOSTS_FILE = ".known-hosts.json";

// The defaults every command resolves against cwd: the config in the intent repo, the artifact in the
// desired-state repo. `init` scaffolds both repos at these same paths.
export const CONFIG_PATH = join(INTENT_DIR, CONFIG_FILE);
export const ARTIFACT_PATH = join(TARGET_DIR, ARTIFACT_FILE);

export const readArtifact = async (path: string): Promise<DesiredStateGraph> => {
    const graph = JSON.parse(await readFile(path, "utf8")) as DesiredStateGraph;
    if (graph.version !== 1) {
        throw new Error(`${path} is not a desired-state artifact (expected version 1)`);
    }
    return graph;
};

export const writeArtifact = async (path: string, graph: DesiredStateGraph): Promise<void> =>
    writeFile(path, `${JSON.stringify(graph, undefined, 4)}\n`);

export const writeStatus = async (path: string, status: unknown): Promise<void> => writeFile(path, `${JSON.stringify(status, undefined, 4)}\n`);

// `apply`/`plan` resolve secrets from process.env; load them from the `.env` beside the artifact being
// executed. Optional: a missing file is fine — CI or the shell may set the vars directly.
export const loadEnvFile = (dir: string): void => {
    const path = join(dir, ENV_FILE);
    if (!existsSync(path)) {
        return;
    }
    process.loadEnvFile(path);
};
