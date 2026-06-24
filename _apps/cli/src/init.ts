import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { CONFIG_FILE } from "./artifact.js";

const exec = promisify(execFile);

const STARTER_CONFIG = `import { env } from "@intentic/graph";
import { defineCandidates } from "@intentic/sdk";

export const candidates = defineCandidates((i) => {
    i.want.app("my-app", {
        environments: {
            production: { domain: "app.example.com", branch: "main", env: { DATABASE_URL: env("PRODUCTION_DATABASE_URL") } },
        },
    });
});
`;

// Scaffold the local control plane: an `intent` repo (holds deploy.config.ts) and a `reconciliation-target`
// repo (holds the artifact `resolve` writes and the status `apply` writes), each its own git repo so the
// generated target can later become PR-managed.
export const scaffold = async (dir: string): Promise<{ readonly intentDir: string; readonly targetDir: string }> => {
    const intentDir = join(dir, "intent");
    const targetDir = join(dir, "reconciliation-target");
    await mkdir(intentDir, { recursive: true });
    await mkdir(targetDir, { recursive: true });
    await exec("git", ["init", "-q", intentDir]);
    await exec("git", ["init", "-q", targetDir]);
    await writeFile(join(intentDir, CONFIG_FILE), STARTER_CONFIG);
    return { intentDir, targetDir };
};
