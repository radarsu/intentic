import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { createServices } from "./composition.js";
import { loadConfig } from "./env.config.js";
import { createLogger } from "./logger.js";
import { registerWithPlatform } from "./register.js";
import { zoneFromPublicUrl } from "./zone.js";

// The sandbox container's entrypoint. Config comes from env set at `docker run` — by connect.sh (your PC) or
// the workspace provider (a server); the workspace (the three repos) and agent credentials are injected there,
// never baked in.
const main = (): void => {
    const config = loadConfig();
    const logger = createLogger(config);
    const services = createServices(config, logger);
    const { workspace } = services;

    // First start with an empty workspace: scaffold the three repos (intent / desired-state / app) so chat,
    // inventory, and source-control have something to read. Idempotent — skipped once the repos exist. With a
    // self-host target + a known zone, the scaffold targets `self` at app.<zone>; otherwise the generic starter.
    if (!existsSync(workspace.repos.intent)) {
        logger.info("empty workspace — running intentic init…");
        const zone = config.zone !== "" ? config.zone : zoneFromPublicUrl(config.sandbox.publicUrl);
        const initArgs = ["init", "--dir", config.workspaceRoot];
        if (services.selfHost !== undefined) {
            initArgs.push("--self-host");
            if (zone !== undefined && zone !== "") {
                initArgs.push("--zone", zone);
            }
        }
        const init = spawnSync("intentic", initArgs, { stdio: "inherit" });
        if (init.status !== 0) {
            logger.warn({ status: init.status ?? undefined }, "intentic init failed; the workspace may be incomplete");
        }
    }

    if (config.dev.command !== "" && config.dev.port !== "") {
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

main();
