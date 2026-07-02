import { resolve } from "node:path";
import { buildCommand, type CommandContext } from "@stricli/core";
import { run as runAgent } from "./agent.js";
import { authorizeInteractive } from "./auth.js";
import { type SyncConfig, writeConfig, writeCredentials } from "./config.js";
import { install as installAutostart, uninstall as uninstallAutostart } from "./install.js";

// The argv that autostart should run at login: this same executable + "run". A packaged single binary has no
// script arg (execPath IS the app); node running dist/cli.js passes the script through.
const runCommand = (): string[] => {
    const script = process.argv[1];
    return script !== undefined && script.endsWith(".js") ? [process.execPath, script, "run"] : [process.execPath, "run"];
};

const sandboxIdFromUrl = (url: string): string => new URL(url).host.replace(/[^a-zA-Z0-9.-]/g, "-");

interface SetupFlags {
    readonly sandboxUrl: string;
    readonly localDir: string;
    readonly clientId: string;
    readonly clientSecret: string;
    readonly sandboxId?: string;
    readonly noAutostart?: boolean;
}

const setup = buildCommand<SetupFlags>({
    docs: { brief: "Authorize with Google, save config, and install the background autostart entry" },
    parameters: {
        flags: {
            sandboxUrl: { kind: "parsed", parse: String, brief: "The sandbox's public URL (e.g. https://sandbox-xxx.example.dev)" },
            localDir: { kind: "parsed", parse: String, brief: "Local directory to mirror the sandbox into" },
            clientId: { kind: "parsed", parse: String, brief: "Google desktop OAuth client id" },
            clientSecret: { kind: "parsed", parse: String, brief: "Google desktop OAuth client secret" },
            sandboxId: { kind: "parsed", parse: String, optional: true, brief: "Manifest namespace (default: the sandbox URL host)" },
            noAutostart: { kind: "boolean", optional: true, brief: "Skip installing the login autostart entry" },
        },
    },
    async func(this: CommandContext, flags: SetupFlags) {
        const refreshToken = await authorizeInteractive(flags.clientId, flags.clientSecret);
        const config: SyncConfig = {
            sandboxUrl: flags.sandboxUrl,
            sandboxId: flags.sandboxId ?? sandboxIdFromUrl(flags.sandboxUrl),
            localDir: resolve(flags.localDir),
            googleClientId: flags.clientId,
            googleClientSecret: flags.clientSecret,
        };
        await writeConfig(config);
        await writeCredentials({ refreshToken });
        this.process.stdout.write(`Saved config; mirroring ${config.sandboxUrl} → ${config.localDir}\n`);
        if (flags.noAutostart !== true) {
            this.process.stdout.write(`${await installAutostart(runCommand())}\n`);
        }
        this.process.stdout.write("Setup complete. The agent is now running in the background (or run `intentic-sync run` in the foreground).\n");
    },
});

const run = buildCommand<Record<string, never>>({
    docs: { brief: "Run the sync agent in the foreground (what autostart invokes at login)" },
    parameters: { flags: {} },
    async func(this: CommandContext) {
        await runAgent();
    },
});

const install = buildCommand<Record<string, never>>({
    docs: { brief: "(Re)install the login autostart entry for the sync agent" },
    parameters: { flags: {} },
    async func(this: CommandContext) {
        this.process.stdout.write(`${await installAutostart(runCommand())}\n`);
    },
});

const uninstall = buildCommand<Record<string, never>>({
    docs: { brief: "Remove the login autostart entry" },
    parameters: { flags: {} },
    async func(this: CommandContext) {
        this.process.stdout.write(`${await uninstallAutostart()}\n`);
    },
});

export const commands = { setup, run, install, uninstall };
