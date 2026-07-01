import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { INTENT_TSCONFIG, intentPackageJson } from "@intentic/scaffold";
import type { Services } from "../composition.js";
import { AGENT_GIT_AUTHOR } from "../git/git.js";

// The sandbox's own version — the intent repo pins @intentic/{graph,sdk} to it (published in the release image).
// Mirrors the CLI's lib/version.ts; resolved relative to this module ({src,dist}/workspace/…/package.json).
const { version } = createRequire(import.meta.url)("../../package.json") as { version: string };

// Make the intent repo provisionable. `resolve` dynamically imports deploy.config.ts, which needs @intentic/graph
// and @intentic/sdk installed in /work/intent. The neutral first-boot ledger deliberately skips the skeleton +
// install so a reachability-only sandbox stays minimal and offline; a sandbox wired as a deploy target
// (SELF_HOST=1) calls this so `resolve`/`apply` work. Idempotent: skips once node_modules is present. Published
// deps at the image's version (link=false) — the intent repo resolves @intentic/* from the registry.
export const ensureIntentInstallable = async (services: Services): Promise<void> => {
    const intent = services.workspace.repos.intent;
    if (existsSync(join(intent, "node_modules"))) {
        return;
    }
    services.logger.info("wiring the intent repo for provisioning (pnpm install)…");
    await services.files.write(join(intent, "package.json"), intentPackageJson(version, false));
    await services.files.write(join(intent, "tsconfig.json"), INTENT_TSCONFIG);
    await services.git.commitAll(intent, "chore(intentic): wire intent repo for provisioning", AGENT_GIT_AUTHOR);
    const install = spawnSync("pnpm", ["install", "--ignore-workspace"], { cwd: intent, stdio: "inherit" });
    if (install.status !== 0) {
        services.logger.warn({ status: install.status ?? undefined }, "pnpm install failed; provisioning may not work until deps resolve");
    }
};
