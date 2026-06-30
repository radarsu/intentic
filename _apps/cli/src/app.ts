import { buildApplication, buildRouteMap, text_en } from "@stricli/core";
import { adopt } from "./adopt/adopt.command.js";
import { apply } from "./apply/apply.command.js";
import { deploymentsCommand } from "./deployments/deployments.command.js";
import { init } from "./init/init.command.js";
import { version } from "./lib/version.js";
import { planCommand } from "./plan/plan.command.js";
import { resolveCommand } from "./resolve/resolve.command.js";
import { restore } from "./restore/restore.command.js";
import { sandboxTunnel } from "./sandbox-tunnel/sandbox-tunnel.command.js";

// User-facing errors should read as a one-line message, not a JS stack trace — the CLI is driven by end users
// (and by connect.sh inside the sandbox), so a thrown Error renders as "Command failed, <message>". Set
// INTENTIC_DEBUG to keep the stack when chasing an unexpected failure. This overrides stricli's default
// formatter, which prints `error.stack`.
const formatException = (exc: unknown): string => {
    if (exc instanceof Error) {
        return process.env["INTENTIC_DEBUG"] !== undefined ? (exc.stack ?? exc.message) : exc.message;
    }
    return String(exc);
};

// The stricli application: each command lives in its own src/<command>/<command>.command.ts; this assembles
// them into the route map. Command names + their kebab flags are unchanged.
export const app = buildApplication(
    buildRouteMap({
        routes: { init, resolve: resolveCommand, plan: planCommand, apply, adopt, restore, deployments: deploymentsCommand, sandboxTunnel },
        docs: { brief: "intentic — intent-driven deployment" },
    }),
    {
        name: "intentic",
        versionInfo: { currentVersion: version },
        scanner: { caseStyle: "allow-kebab-for-camel" },
        localization: { loadText: (locale) => (locale.startsWith("en") ? { ...text_en, formatException } : undefined) },
    },
);
