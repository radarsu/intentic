import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { APP_DIR, CONFIG_FILE, ENV_FILE, INTENT_DIR, LAST_APPLIED_FILE, SECRETS_FILE, TARGET_DIR } from "../lib/artifact.js";

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
        apiToken: env("CLOUDFLARE_API_TOKEN"),
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

// Self-host variant: when the sandbox was wired with a local deploy target (connect.{sh,ps1}), scaffold the
// example app onto `self` — the host the daemon auto-registers in the managed `// <intentic>` block — so
// Provision works with no edits. `self` is referenced, never declared here (the daemon owns that declaration; a
// second one would duplicate it). The domain is app.<zone> for the sandbox's Cloudflare zone (falls back to the
// example placeholder when the zone is unknown). No DB env — the zero-dependency starter app needs none.
export const selfHostConfig = (zone: string | undefined): string => `import { env } from "@intentic/graph";
import { defineIntent } from "@intentic/sdk";

export const intent = defineIntent((i) => {
    const cf = i.have.cloudflare("cf", {
        apiToken: env("CLOUDFLARE_API_TOKEN"),
    });

    // \`self\` is your local deploy target (this machine / its Docker-in-Docker host). intentic registers it in
    // the managed \`// <intentic>\` block at the top of this file — reference it with \`on: self\`, don't redeclare it.
    i.want.app("my-app", {
        on: self,
        expose: cf,
        environments: {
            production: { domain: "app.${zone ?? "example.com"}", branch: "main" },
        },
    });
});
`;

// Keep secret + local-only files out of the PR-managed desired-state repo: the user-supplied `.env`, the
// intentic-generated `.secrets.json`, and the `.last-applied.json` prune baseline (local snapshot of the
// last successfully-applied artifact). The matching `.env.example` is not written here — `resolve`
// generates it from the graph, the only complete source of the required keys (the resolver injects
// platform secrets the authored config never names).
const TARGET_GITIGNORE = `${ENV_FILE}\n${SECRETS_FILE}\n${LAST_APPLIED_FILE}\n`;

// The intent repo is a self-contained TS project; `init` runs `pnpm install` in it, producing a
// node_modules/ that must stay out of the repo.
const INTENT_GITIGNORE = "node_modules/\n";

const APP_GITIGNORE = "node_modules/\n";

// A minimal, runnable starter app: `pnpm dev` serves it on DEV_PORT (the sandbox runs it; the Cloudflare
// tunnel fronts it at `*.preview.<zone>`), and the Dockerfile is the deploy build CI runs. Zero dependencies,
// so there is no install step — the agent fills it in. Importing an existing repo (--app) skips all of this.
const STARTER_APP_PACKAGE = `${JSON.stringify(
    {
        name: "app",
        version: "0.0.0",
        private: true,
        type: "module",
        scripts: { dev: "node server.js", start: "node server.js" },
    },
    undefined,
    4,
)}\n`;

const STARTER_APP_SERVER = `import { createServer } from "node:http";

// Komodo sets PORT in production; the sandbox passes DEV_PORT for the live preview.
const port = Number(process.env.PORT ?? process.env.DEV_PORT ?? 5173);

createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><title>intentic app</title><h1>It works 🎉</h1><p>Edit <code>server.js</code> — the agent works on this repo.</p>");
}).listen(port, () => console.log(\`app listening on :\${port}\`));
`;

const STARTER_APP_DOCKERFILE = `# intentic starter Dockerfile — replace with your app's real build.
FROM node:24.18.0-alpine3.24
WORKDIR /app
COPY . .
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
`;

// The third repo: the application code the agent edits and previews, mounted at /work/app in the sandbox.
// Either clone an existing repo (--app <url>) to adopt it as-is, or scaffold a minimal runnable starter so
// the live preview works immediately. Always its own git repo, so `adopt` can later push it to Forgejo/GitHub.
const scaffoldApp = async (appDir: string, appRepo: string | undefined): Promise<void> => {
    if (appRepo !== undefined) {
        await exec("git", ["clone", "-q", appRepo, appDir]);
        return;
    }
    await mkdir(appDir, { recursive: true });
    await exec("git", ["init", "-q", appDir]);
    await writeFile(join(appDir, "package.json"), STARTER_APP_PACKAGE);
    await writeFile(join(appDir, "server.js"), STARTER_APP_SERVER);
    await writeFile(join(appDir, "Dockerfile"), STARTER_APP_DOCKERFILE);
    await writeFile(join(appDir, ".gitignore"), APP_GITIGNORE);
};

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

// Scaffold the local workspace: an `intent` repo (holds deploy.config.ts and its package), a `desired-state`
// repo (holds the artifact `resolve` writes and the status `apply` writes), and an `app` repo (the
// application code), each its own git repo so the generated target can later become PR-managed and `adopt`
// can push it. The intent repo is a self-contained TS project against `@intentic/{graph,sdk}` — pinned to the
// CLI's own version, or linked to local source with `--link`. `appRepo`, when set, clones an existing repo as
// the app instead of scaffolding a starter. `selfHost` scaffolds the example app onto the auto-registered
// `self` deploy target (domain app.`zone`) so Provision works with no edits; otherwise a placeholder remote host.
export const scaffold = async (
    dir: string,
    version: string,
    link: boolean,
    appRepo: string | undefined,
    selfHost: boolean,
    zone: string | undefined,
): Promise<{ readonly intentDir: string; readonly targetDir: string; readonly appDir: string }> => {
    const intentDir = join(dir, INTENT_DIR);
    const targetDir = join(dir, TARGET_DIR);
    const appDir = join(dir, APP_DIR);
    try {
        await mkdir(intentDir, { recursive: true });
        await mkdir(targetDir, { recursive: true });
        await exec("git", ["init", "-q", intentDir]);
        await exec("git", ["init", "-q", targetDir]);
        await writeFile(join(intentDir, CONFIG_FILE), selfHost ? selfHostConfig(zone) : STARTER_CONFIG);
        await writeFile(join(intentDir, "package.json"), starterPackage(version, link));
        await writeFile(join(intentDir, "tsconfig.json"), STARTER_TSCONFIG);
        await writeFile(join(intentDir, ".gitignore"), INTENT_GITIGNORE);
        await writeFile(join(targetDir, ".gitignore"), TARGET_GITIGNORE);
        // The app repo is independent of the intent's deps, so scaffold it BEFORE `pnpm install`: a failed install
        // must not also cost us /work/app (the dev server's cwd — its absence surfaces as a confusing `spawn pnpm
        // ENOENT`). The install goes last, as the one step that reaches the network and is most likely to fail.
        await scaffoldApp(appDir, appRepo);
        await exec("pnpm", ["install", "--ignore-workspace"], { cwd: intentDir });
    } catch (error) {
        // All-or-nothing: a partial scaffold leaves /work/intent in place, and the daemon gates init on its
        // existence (sandbox main.ts), so a half-built workspace would freeze the failure across every restart.
        // Remove what we created so the next boot re-inits from a clean slate (CLAUDE.md: assume fresh state).
        await rm(intentDir, { recursive: true, force: true });
        await rm(targetDir, { recursive: true, force: true });
        await rm(appDir, { recursive: true, force: true });
        throw error;
    }
    return { intentDir, targetDir, appDir };
};
