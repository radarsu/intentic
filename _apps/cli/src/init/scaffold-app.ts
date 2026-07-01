import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { renderTemplate } from "../lib/templates.js";

const exec = promisify(execFile);

const APP_GITIGNORE = "node_modules/\n";

// A minimal, runnable starter app: `pnpm dev` serves it on DEV_PORT (the sandbox runs it; the Cloudflare
// tunnel fronts it at `*.preview.<zone>`), and the Dockerfile is the deploy build CI runs. Zero dependencies,
// so there is no install step — the agent fills it in. Importing an existing repo (appRepo) skips all of this.
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

// The application code the agent edits and previews, mounted at /work/app in the sandbox. Either clone an
// existing repo (`appRepo`) to adopt it as-is, or scaffold a minimal runnable starter so the live preview works
// immediately. Always its own git repo, so `adopt` can later push it to Forgejo/GitHub. Reused by `init` (the
// full three-repo scaffold) and `add-app` (adding the app to an existing neutral workspace).
export const scaffoldApp = async (appDir: string, appRepo: string | undefined): Promise<void> => {
    if (appRepo !== undefined) {
        await exec("git", ["clone", "-q", appRepo, appDir]);
        return;
    }
    await mkdir(appDir, { recursive: true });
    await exec("git", ["init", "-q", appDir]);
    await writeFile(join(appDir, "package.json"), STARTER_APP_PACKAGE);
    await writeFile(join(appDir, "server.js"), renderTemplate("scaffold/server.js", {}));
    await writeFile(join(appDir, "Dockerfile"), renderTemplate("scaffold/Dockerfile", {}));
    await writeFile(join(appDir, ".gitignore"), APP_GITIGNORE);
};
