import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CONFIG_FILE, ENV_FILE, INTENT_DIR, SECRETS_FILE, TARGET_DIR } from "./artifact.js";

const exec = promisify(execFile);

const STARTER_CONFIG = `import { env } from "@intentic/graph";
import { defineIntent } from "@intentic/sdk";

export const intent = defineIntent((i) => {
    const host = i.have.host("host", {
        address: "203.0.113.10",
        user: "deploy",
        sshKey: env("HOST_SSH_KEY"),
    });

    const cf = i.have.cloudflare("cf", {
        accountId: "acc_123",
        apiToken: env("CLOUDFLARE_API_TOKEN"),
        zone: "example.com",
    });

    i.want.app("my-app", {
        on: host,
        expose: cf,
        environments: {
            production: { domain: "app.example.com", branch: "main", env: { DATABASE_URL: env("PRODUCTION_DATABASE_URL") } },
        },
    });
});
`;

// Keep the secret files out of the PR-managed desired-state repo: the user-supplied `.env` and the
// intentic-generated `.secrets.json` (Forgejo/Komodo admin credentials). The matching `.env.example` is not
// written here — `resolve` generates it from the graph, the only complete source of the required keys (the
// resolver injects platform secrets the authored config never names).
const TARGET_GITIGNORE = `${ENV_FILE}\n${SECRETS_FILE}\n`;

// A standalone TS project for the one config file: type-strip-importable by `resolve`, type-checked in an
// editor against the @intentic/* packages' shipped declarations (no build of the intent repo itself).
const STARTER_TSCONFIG = `${JSON.stringify(
    {
        compilerOptions: { module: "nodenext", moduleResolution: "nodenext", target: "ES2024", strict: true, skipLibCheck: true, noEmit: true },
        include: [CONFIG_FILE],
    },
    undefined,
    4,
)}\n`;

// `--link` resolves @intentic/* to this monorepo's local source instead of the registry, so the CLI can be
// dogfooded against unpublished packages. Computed from the compiled CLI location: dist → cli → _apps → root.
const LIBS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "_libs");

const starterPackage = (version: string, link: boolean): string => {
    const dependency = (pkg: string): string => (link ? `link:${join(LIBS_DIR, pkg)}` : `~${version}`);
    return `${JSON.stringify(
        {
            name: "intent",
            version: "0.0.0",
            private: true,
            type: "module",
            dependencies: { "@intentic/graph": dependency("graph"), "@intentic/sdk": dependency("sdk") },
        },
        undefined,
        4,
    )}\n`;
};

// Scaffold the local control plane: an `intent` repo (holds deploy.config.ts and its package) and a
// `desired-state` repo (holds the artifact `resolve` writes and the status `apply` writes), each its own git
// repo so the generated target can later become PR-managed. The intent repo is a self-contained TS project
// against `@intentic/{graph,sdk}` — pinned to the CLI's own version, or linked to local source with `--link`.
export const scaffold = async (dir: string, version: string, link: boolean): Promise<{ readonly intentDir: string; readonly targetDir: string }> => {
    const intentDir = join(dir, INTENT_DIR);
    const targetDir = join(dir, TARGET_DIR);
    await mkdir(intentDir, { recursive: true });
    await mkdir(targetDir, { recursive: true });
    await exec("git", ["init", "-q", intentDir]);
    await exec("git", ["init", "-q", targetDir]);
    await writeFile(join(intentDir, CONFIG_FILE), STARTER_CONFIG);
    await writeFile(join(intentDir, "package.json"), starterPackage(version, link));
    await writeFile(join(intentDir, "tsconfig.json"), STARTER_TSCONFIG);
    await writeFile(join(targetDir, ".gitignore"), TARGET_GITIGNORE);
    await exec("pnpm", ["install", "--ignore-workspace"], { cwd: intentDir });
    return { intentDir, targetDir };
};
