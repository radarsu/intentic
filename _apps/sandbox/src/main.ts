import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createAuthorizer, createGoogleVerifier, fileOwnerStore } from "./auth.js";
import { createDaemon } from "./daemon.js";
import { createDevServer } from "./dev-server.js";
import { registerWithPlatform } from "./register.js";
import { internalTools } from "./tools.js";
import { workspacePaths } from "./workspace.js";

// The sandbox container's entrypoint. Config comes from env set at `docker run` — by connect.sh (your PC) or
// the workspace provider (a server); the workspace (the three repos) and agent credentials are injected there,
// never baked in.
const root = process.env["WORKSPACE_ROOT"] ?? "/work";
const port = Number(process.env["SANDBOX_PORT"] ?? "8787");
// Binds 0.0.0.0 by default: the daemon is reached over the sandbox's Cloudflare tunnel (your PC) or at the
// host's internal ip (a server) — never a host-published port by default. Override with SANDBOX_HOST for local runs.
const host = process.env["SANDBOX_HOST"] ?? "0.0.0.0";
const workspace = workspacePaths(root);
const devServer = createDevServer();

// First start with an empty workspace: scaffold the three repos (intent / desired-state / app) so chat,
// inventory, and source-control have something to read, and the dev server has an app to run. Idempotent —
// skipped once the repos exist. `intentic apply` (run later via the Provision action) reads the infra secrets
// set in this container's env (by connect.sh / the workspace provider).
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

// When SELF_HOST_USER (+ HOST_SSH_KEY) is set, this sandbox runs on a host wired as a deploy target — expose
// it so the `self` inventory host gets registered. address/port are fixed: the sandbox reaches the host it
// runs on at host.docker.internal:22 (connect.sh / the provider add the host-gateway mapping).
const selfHostUser = process.env["SELF_HOST_USER"];
const selfHost =
    selfHostUser !== undefined && selfHostUser !== "" && (process.env["HOST_SSH_KEY"] ?? "") !== ""
        ? { user: selfHostUser, address: "host.docker.internal", port: 22 }
        : undefined;

// The intent-declared internal MCP tools the workspace provider set in this container's env (base64 JSON).
// Constant for this sandbox's life; the daemon merges them with the sandbox's own stored external tools each turn.
const tools = internalTools(process.env["INTENTIC_AGENT_TOOLS"]);

// Browser-facing auth (the decentralized path): when a Google web client id is configured, this sandbox is
// reached directly by the browser, so the daemon verifies each request's Google ID token (audience = this
// client id) and binds its owner on first use. CONNECT_TOKEN, when set, gates that first bind; WEB_ORIGIN
// scopes CORS to the platform's web app. Absent ⇒ loopback mode (tests only — the daemon stays open). See auth.ts.
const googleClientId = process.env["GOOGLE_CLIENT_ID"];
const connectToken = process.env["CONNECT_TOKEN"];
const webOrigin = process.env["WEB_ORIGIN"];
const auth =
    googleClientId !== undefined && googleClientId !== ""
        ? {
              authorize: createAuthorizer({
                  verify: createGoogleVerifier(googleClientId),
                  owner: fileOwnerStore(join(root, ".intentic", "owner.json")),
                  ...(connectToken !== undefined && connectToken !== "" ? { connectToken } : {}),
              }).authorize,
              ...(webOrigin !== undefined && webOrigin !== "" ? { allowOrigin: webOrigin } : {}),
          }
        : undefined;

// This sandbox's identity for the platform's Connections card (container name + image), forwarded by connect.sh
// / the provider. Both must be set to surface anything; absent ⇒ /info returns {} (loopback/test mode).
const sandboxName = process.env["SANDBOX_NAME"];
const sandboxImage = process.env["SANDBOX_IMAGE"];
const info =
    sandboxName !== undefined && sandboxName !== "" && sandboxImage !== undefined && sandboxImage !== ""
        ? { name: sandboxName, image: sandboxImage }
        : undefined;

const app = createDaemon({
    workspace,
    devServer,
    ...(selfHost !== undefined ? { selfHost } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(auth !== undefined ? { auth } : {}),
    ...(info !== undefined ? { info } : {}),
});
serve({ fetch: app.fetch, port, hostname: host });
process.stdout.write(`intentic sandbox daemon listening on http://${host}:${port} (workspace ${root})\n`);

// Decentralized path: tell the platform where to reach this sandbox directly (best-effort, off the command
// path). Needs the platform URL + connection token + this sandbox's public URL, all set in this container's env.
const platformUrl = process.env["PLATFORM_URL"];
const sandboxPublicUrl = process.env["SANDBOX_PUBLIC_URL"];
if (
    platformUrl !== undefined &&
    platformUrl !== "" &&
    connectToken !== undefined &&
    connectToken !== "" &&
    sandboxPublicUrl !== undefined &&
    sandboxPublicUrl !== ""
) {
    const registration = { platformUrl, connectToken, daemonUrl: sandboxPublicUrl, log: (message: string) => process.stdout.write(`${message}\n`) };
    void registerWithPlatform(registration);
    // Heartbeat: keep the platform's lastSeenAt fresh so its setup gate can tell `ready` (alive) from `connecting`.
    setInterval(() => void registerWithPlatform(registration), 60_000);
}
