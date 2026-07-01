import { buildCommand, type CommandContext } from "@stricli/core";
import { loadConfig } from "../env.config.js";
import { createOutput } from "../lib/output.js";
import { addApp } from "./add-app.js";

export const addAppCommand = buildCommand<{ dir?: string; app?: string }>({
    docs: { brief: "Scaffold (or adopt with --app) the deployable app repo at <dir>/app" },
    parameters: {
        flags: {
            dir: { kind: "parsed", parse: String, optional: true, brief: "Directory holding the workspace (default: .)" },
            app: { kind: "parsed", parse: String, optional: true, brief: "Clone this git URL as the app repo instead of scaffolding a starter" },
        },
    },
    async func(this: CommandContext, flags: { dir?: string; app?: string }) {
        const out = createOutput(this.process.stdout, loadConfig().intenticOutput);
        const { appDir } = await addApp(flags.dir ?? ".", flags.app);
        out.text(`initialized ${appDir}`);
        out.result({ appDir });
    },
});
