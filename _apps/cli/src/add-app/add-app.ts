import { existsSync } from "node:fs";
import { join } from "node:path";
import { scaffoldApp } from "../init/scaffold-app.js";
import { APP_DIR } from "../lib/artifact.js";

// Add the deployable app to an existing workspace: scaffold a starter (or adopt `appRepo`) at <dir>/app. Refuses
// when it already exists so a re-run can't clobber the user's code — the app repo is created once, then edited in
// place. Used after `init --minimal` (a reachability-only workspace) to grow into building/deploying an app.
export const addApp = async (dir: string, appRepo: string | undefined): Promise<{ readonly appDir: string }> => {
    const appDir = join(dir, APP_DIR);
    if (existsSync(appDir)) {
        throw new Error(`an app already exists at ${appDir}`);
    }
    await scaffoldApp(appDir, appRepo);
    return { appDir };
};
