import { createRequire } from "node:module";
import type { CommandContext, FlagParametersForType } from "@stricli/core";
import { buildApplication, buildCommand, buildRouteMap, numberParser } from "@stricli/core";
import { bootstrap } from "./bootstrap.js";
import type { ControlPlaneFlags } from "./config.js";
import { readConfig } from "./config.js";
import { runController } from "./controller.js";
import { evaluateIntentSource } from "./evaluate-intent.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

// Shared control-plane config flags — both `up` and `watch` need the full ControlPlaneConfig. Each flag is
// optional and falls back to its env var inside readConfig.
const controlPlaneFlags: FlagParametersForType<ControlPlaneFlags> = {
    hostAddress: { kind: "parsed", parse: String, optional: true, brief: "Control host address (env INTENTIC_HOST_ADDRESS)" },
    hostUser: { kind: "parsed", parse: String, optional: true, brief: "Control host SSH user (env INTENTIC_HOST_USER)" },
    hostPort: { kind: "parsed", parse: numberParser, optional: true, brief: "Control host SSH port (env INTENTIC_HOST_PORT)" },
    internalIp: { kind: "parsed", parse: String, optional: true, brief: "Control plane internal IP (env INTENTIC_CONTROL_INTERNAL_IP)" },
    domain: { kind: "parsed", parse: String, optional: true, brief: "Control plane git domain (env INTENTIC_CONTROL_DOMAIN)" },
};

const up = buildCommand<ControlPlaneFlags>({
    docs: { brief: "Bootstrap the control plane and print the outcome" },
    parameters: { flags: controlPlaneFlags },
    async func(this: CommandContext, flags: ControlPlaneFlags) {
        const outcome = await bootstrap(readConfig(flags));
        this.process.stdout.write(`${JSON.stringify(outcome, undefined, 4)}\n`);
    },
});

interface WatchFlags extends ControlPlaneFlags {
    readonly pollInterval?: number;
    readonly maxIterations?: number;
}

const watch = buildCommand<WatchFlags>({
    docs: { brief: "Watch the intent repo and run the reconcile control loop" },
    parameters: {
        flags: {
            ...controlPlaneFlags,
            pollInterval: { kind: "parsed", parse: numberParser, optional: true, brief: "Intent poll interval in ms (default 15000)" },
            maxIterations: { kind: "parsed", parse: numberParser, optional: true, brief: "Max reconcile iterations per cycle (default 5)" },
        },
    },
    async func(flags: WatchFlags) {
        await runController({
            config: readConfig(flags),
            evaluateIntent: evaluateIntentSource,
            ...(flags.pollInterval !== undefined ? { pollIntervalMs: flags.pollInterval } : {}),
            ...(flags.maxIterations !== undefined ? { maxIterations: flags.maxIterations } : {}),
        });
    },
});

export const app = buildApplication(
    buildRouteMap({
        routes: {
            "control-plane": buildRouteMap({
                routes: { up, watch },
                docs: { brief: "Manage the standalone control plane" },
            }),
        },
        docs: { brief: "intentic — intent-driven deployment" },
    }),
    {
        name: "intentic",
        versionInfo: { currentVersion: version },
        scanner: { caseStyle: "allow-kebab-for-camel" },
    },
);
