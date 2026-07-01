import { join } from "node:path";
import { scaffoldDeployConfig } from "@intentic/scaffold";
import type { Services } from "../composition.js";
import { AGENT_GIT_AUTHOR } from "../git/git.js";

const CONFIG_FILE = "deploy.config.ts";

// Read/write + commit the intent repo's deploy.config.ts. The daemon owns this file (the browser edits it only
// through daemon routes, never directly); a repo with no config yet reads as a fresh neutral scaffold. Shared by
// the inventory routes and the app-scaffold route so the file + commit logic lives in one place.
export interface ConfigStore {
    readonly read: () => Promise<string>;
    readonly write: (content: string, message: string) => Promise<void>;
}

export const createConfigStore = (services: Services): ConfigStore => {
    const configPath = join(services.workspace.repos.intent, CONFIG_FILE);
    return {
        read: async () => (await services.files.read(configPath)) ?? scaffoldDeployConfig([]),
        write: async (content, message) => {
            await services.files.write(configPath, content);
            await services.git.commitAll(services.workspace.repos.intent, message, AGENT_GIT_AUTHOR);
        },
    };
};
