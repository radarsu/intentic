import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { serve } from "@hono/node-server";
import { createDaemon } from "./daemon.js";
import { createDevServer } from "./dev-server.js";
import { internalTools } from "./tools.js";
import { workspacePaths } from "./workspace.js";

// The sandbox container's entrypoint. Config comes from env the runner sets at `docker run`; the workspace
// (the three repos) and agent credentials are injected by the runner, never baked in.
const root = process.env["WORKSPACE_ROOT"] ?? "/work";
const port = Number(process.env["SANDBOX_PORT"] ?? "8787");
// Binds 0.0.0.0 by default: the sandbox sits on a private, non-host-published docker network, and the runner
// reaches its daemon by container name across that network. Override with SANDBOX_HOST for local runs.
const host = process.env["SANDBOX_HOST"] ?? "0.0.0.0";
const workspace = workspacePaths(root);
const devServer = createDevServer();

// First start with an empty workspace: scaffold the three repos (intent / desired-state / app) so chat,
// inventory, and source-control have something to read, and the dev server has an app to run. Idempotent —
// skipped once the repos exist. `intentic apply` (run later via the platform's Provision action) reads the
// infra secrets the runner injected into this container's env.
if (!existsSync(workspace.repos.intent)) {
    process.stdout.write(`intentic sandbox: empty workspace — running intentic init…\n`);
    const init = spawnSync("intentic", ["init", "--dir", root], { stdio: "inherit" });
    if (init.status !== 0) {
        process.stdout.write(`intentic sandbox: intentic init failed (status ${init.status ?? "?"}); the workspace may be incomplete\n`);
    }
}

const devCommand = process.env["DEV_COMMAND"];
const devPort = process.env["DEV_PORT"];
if (devCommand !== undefined && devCommand !== "" && devPort !== undefined) {
    devServer.start({ command: devCommand.split(" "), cwd: workspace.repos.app, port: Number(devPort) });
}

// When the runner forwarded SELF_HOST_USER (+ HOST_SSH_KEY), this sandbox runs on a host wired as a deploy
// target — expose it so the platform registers the `self` inventory host. address/port are fixed: the sandbox
// reaches the host it runs on at host.docker.internal:22 (the runner adds the host-gateway mapping).
const selfHostUser = process.env["SELF_HOST_USER"];
const selfHost =
    selfHostUser !== undefined && selfHostUser !== "" && (process.env["HOST_SSH_KEY"] ?? "") !== ""
        ? { user: selfHostUser, address: "host.docker.internal", port: 22 }
        : undefined;

// The intent-declared internal MCP tools the workspace provider forwarded through the runner (base64 JSON).
// Constant for this sandbox's life; the daemon merges them with each turn's platform-relayed external tools.
const tools = internalTools(process.env["INTENTIC_AGENT_TOOLS"]);

const app = createDaemon({ workspace, devServer, ...(selfHost !== undefined ? { selfHost } : {}), ...(tools.length > 0 ? { tools } : {}) });
serve({ fetch: app.fetch, port, hostname: host });
process.stdout.write(`intentic sandbox daemon listening on http://${host}:${port} (workspace ${root})\n`);
