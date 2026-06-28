import { serve } from "@hono/node-server";
import { createDaemon } from "./daemon.js";
import { createDevServer } from "./dev-server.js";
import { workspacePaths } from "./workspace.js";

// The sandbox container's entrypoint. Config comes from env the runner sets at `docker run`; the workspace
// (the three cloned repos) and agent credentials (ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN) are mounted
// /injected by the runner, never baked in.
const root = process.env["WORKSPACE_ROOT"] ?? "/work";
const port = Number(process.env["SANDBOX_PORT"] ?? "8787");
// Binds 0.0.0.0 by default: the sandbox sits on a private, non-host-published docker network, and the runner
// reaches its daemon by container name across that network. Override with SANDBOX_HOST for local runs.
const host = process.env["SANDBOX_HOST"] ?? "0.0.0.0";
const workspace = workspacePaths(root);
const devServer = createDevServer();

const devCommand = process.env["DEV_COMMAND"];
const devPort = process.env["DEV_PORT"];
if (devCommand !== undefined && devCommand !== "" && devPort !== undefined) {
    devServer.start({ command: devCommand.split(" "), cwd: workspace.repos.app, port: Number(devPort) });
}

const app = createDaemon({ workspace, devServer });
serve({ fetch: app.fetch, port, hostname: host });
process.stdout.write(`intentic sandbox daemon listening on http://${host}:${port} (workspace ${root})\n`);
