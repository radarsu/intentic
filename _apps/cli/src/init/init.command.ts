import { buildCommand, type CommandContext } from "@stricli/core";
import { CONFIG_FILE } from "../lib/artifact.js";
import { createOutput, outputMode } from "../lib/output.js";
import { version } from "../lib/version.js";
import { scaffold } from "./init.js";

export const init = buildCommand<{ dir?: string; link: boolean; app?: string; selfHost: boolean; zone?: string }>({
    docs: { brief: "Scaffold local intent, desired-state, and app git repos" },
    parameters: {
        flags: {
            dir: { kind: "parsed", parse: String, optional: true, brief: "Directory to scaffold in (default: .)" },
            link: { kind: "boolean", brief: "Link @intentic/* to this monorepo's _libs for local development against unpublished packages" },
            app: { kind: "parsed", parse: String, optional: true, brief: "Clone this git URL as the app repo instead of scaffolding a starter app" },
            selfHost: {
                kind: "boolean",
                brief: "Scaffold the example app onto the auto-registered `self` deploy target (this machine) instead of a placeholder remote host",
            },
            zone: {
                kind: "parsed",
                parse: String,
                optional: true,
                brief: "Cloudflare zone for the scaffolded app's domain (app.<zone>); used with --self-host",
            },
        },
    },
    async func(this: CommandContext, flags: { dir?: string; link: boolean; app?: string; selfHost: boolean; zone?: string }) {
        const out = createOutput(this.process.stdout, outputMode(process.env));
        const { intentDir, targetDir, appDir } = await scaffold(flags.dir ?? ".", version, flags.link, flags.app, flags.selfHost, flags.zone);
        out.text(`initialized ${intentDir} (with ${CONFIG_FILE}), ${targetDir}, and ${appDir}`);
        out.result({ intentDir, targetDir, appDir });
    },
});
