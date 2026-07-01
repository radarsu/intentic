import { existsSync } from "node:fs";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { createServices } from "./composition.js";
import { loadConfig } from "./env.config.js";
import { createLogger } from "./logger.js";
import { registerWithPlatform } from "./system/register.js";
import { scaffoldNeutralLedger } from "./workspace/scaffold-ledger.js";

// The sandbox container's entrypoint. Config comes from env set at `docker run` — by connect.sh (your PC) or
// the workspace provider (a server); the workspace (the repos) and agent credentials are injected there,
// never baked in.
const main = async (): Promise<void> => {
    const config = loadConfig();
    const logger = createLogger(config);
    const services = createServices(config, logger);
    const { workspace } = services;

    // First start with an empty workspace: scaffold a NEUTRAL ledger (intent + desired-state, no app) so chat,
    // inventory, and source-control have something to read. Setup is reachability-only — nothing is provisioned
    // and no deploy target is wired; the app repo + a deploy target arrive later via "Deploy on this machine".
    // Idempotent — skipped once the repos exist.
    if (!existsSync(workspace.repos.intent)) {
        logger.info("empty workspace — scaffolding a neutral ledger…");
        await scaffoldNeutralLedger(services);
    }

    // The app repo only exists once the user opts to build/deploy an app; skip the preview until then.
    if (config.dev.command !== "" && config.dev.port !== "" && existsSync(workspace.repos.app)) {
        services.devServer.start({ command: config.dev.command.split(" "), cwd: workspace.repos.app, port: Number(config.dev.port) });
    }

    const app = createApp(services);
    const server = serve({ fetch: app.fetch, port: config.sandbox.port, hostname: config.sandbox.host });
    logger.info({ host: config.sandbox.host, port: config.sandbox.port, workspace: config.workspaceRoot }, "intentic sandbox daemon listening");

    // Decentralized path: tell the platform where to reach this sandbox directly (best-effort, off the command
    // path). Needs the platform URL + connection token + this sandbox's public URL.
    if (config.platformUrl !== "" && config.connectToken !== "" && config.sandbox.publicUrl !== "") {
        const registration = {
            platformUrl: config.platformUrl,
            connectToken: config.connectToken,
            daemonUrl: config.sandbox.publicUrl,
            log: (message: string) => logger.info(message),
        };
        void registerWithPlatform(registration);
        // Heartbeat: keep the platform's lastSeenAt fresh so its setup gate can tell `ready` from `connecting`.
        setInterval(() => void registerWithPlatform(registration), 60_000);
    }

    const shutdown = (): void => {
        logger.info("shutting down intentic sandbox daemon…");
        services.devServer.stop();
        server.close();
        process.exit(0);
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
};

void main();
