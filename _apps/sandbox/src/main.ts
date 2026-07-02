import { existsSync } from "node:fs";
import { serve, type WebSocketServerLike } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { createApp } from "./app.js";
import { createAutomationsScheduler } from "./automations/scheduler.js";
import { createServices } from "./composition.js";
import { loadConfig } from "./env.config.js";
import { createLogger } from "./logger.js";
import { registerWithPlatform } from "./system/register.js";
import { seedPairing } from "./system/sync.js";

// The sandbox container's entrypoint. Config comes from env set at `docker run` — by connect.sh (your PC) or
// the workspace provider (a server); the workspace (the repos) and agent credentials are injected there,
// never baked in.
const main = async (): Promise<void> => {
    const config = loadConfig();
    const logger = createLogger(config);
    const services = createServices(config, logger);
    const { workspace } = services;

    // Setup-time desktop sync: arm the platform-minted pairing token so the connect script can enroll its agent.
    if (config.syncPairToken !== "") {
        seedPairing(config.syncPairToken);
    }

    // The sandbox boots physically empty — no intent/desired-state repos. They're scaffolded on demand when the
    // user activates the DevOps capability (see capabilities/handlers/devops.ts). The app repo likewise only
    // exists once an app is built/deployed; skip the preview until then.
    if (config.dev.command !== "" && config.dev.port !== "" && existsSync(workspace.repos.app)) {
        services.devServer.start({ command: config.dev.command.split(" "), cwd: workspace.repos.app, port: Number(config.dev.port) });
    }

    const app = createApp(services);
    // The interactive-terminal WebSocket (/system/terminal) rides node-server's native WS support: `ws` in
    // noServer mode handles the upgrade, node-server routes it through Hono's upgradeWebSocket to the terminal.
    // `ws`'s WebSocketServer types its options.noServer as `boolean | undefined`; node-server's WebSocketServerLike
    // wants a plain boolean under exactOptionalPropertyTypes. The shapes match at runtime — assert the interface.
    const terminalSockets = new WebSocketServer({ noServer: true }) as unknown as WebSocketServerLike;
    const server = serve({ fetch: app.fetch, port: config.sandbox.port, hostname: config.sandbox.host, websocket: { server: terminalSockets } });
    logger.info({ host: config.sandbox.host, port: config.sandbox.port, workspace: config.workspaceRoot }, "intentic sandbox daemon listening");

    // Scheduled agent wake-ups: poll the automations manifest and fire whatever comes due.
    const scheduler = createAutomationsScheduler(services);
    scheduler.start();

    // Workspace history: an immediate snapshot plus the interval sweep (turn snapshots ride on streamAgent).
    services.history.start();

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
        scheduler.stop();
        services.history.stop();
        services.devServer.stop();
        server.close();
        process.exit(0);
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
};

void main();
