import { serve } from "@hono/node-server";
import { connectChannel } from "./channel.js";
import { createController } from "./control.js";
import { createPreviewProxy } from "./proxy-server.js";

// The runner container's entrypoint. Always starts the host-published preview reverse proxy that the wildcard
// `*.preview.<zone>` tunnel ingress points at. When the workspace opted into the control plane (PLATFORM_URL +
// RUNNER_TOKEN are set by the provider), it also dials the platform's WSS gateway and serves sandbox commands
// over it — the runner is the dialer, so the host needs no inbound port.
const zone = process.env["ZONE"] ?? "";
const previewPort = Number(process.env["PREVIEW_PORT"] ?? "8088");
const devPort = Number(process.env["SANDBOX_DEV_PORT"] ?? "5173");
const daemonPort = Number(process.env["SANDBOX_DAEMON_PORT"] ?? "8787");

const platformUrl = process.env["PLATFORM_URL"];
const runnerToken = process.env["RUNNER_TOKEN"];

// The proxy also serves `/__agent` (the browser driving the agent directly) when a runner token is set to
// verify the platform-minted bearer; preview-only hosts get just the dev-server proxy.
const proxy = createPreviewProxy({
    zone,
    devPort,
    daemonPort,
    ...(runnerToken !== undefined && runnerToken !== "" ? { runnerToken } : {}),
});
serve({ fetch: proxy.fetch, port: previewPort, hostname: "0.0.0.0" });
process.stdout.write(`intentic runner: preview proxy on 0.0.0.0:${previewPort} for *.preview.${zone}\n`);
// A custom Anthropic-compatible endpoint (e.g. a local model gateway), exported into each sandbox so the
// agent uses it. Agent CREDENTIALS are still never held here — the platform injects them per turn.
const agentBaseUrl = process.env["ANTHROPIC_BASE_URL"];
// Env forwarded into the sandbox container. Agent CREDENTIALS are never held here (the platform injects the
// Claude token per turn). The infra secrets ride the connect command's environment straight into the sandbox,
// so the in-sandbox `intentic apply` resolves them from process.env — they never touch the platform.
const sandboxEnv: Record<string, string> = {};
if (agentBaseUrl !== undefined && agentBaseUrl !== "") {
    sandboxEnv["ANTHROPIC_BASE_URL"] = agentBaseUrl;
}
// SELF_HOST_USER rides along when connect.sh wired this machine as a deploy target: the sandbox exposes it via
// /self-host so the platform registers the `self` inventory host that HOST_SSH_KEY authenticates.
for (const key of ["HOST_SSH_KEY", "CLOUDFLARE_API_TOKEN", "SELF_HOST_USER"]) {
    const value = process.env[key];
    if (value !== undefined && value !== "") {
        sandboxEnv[key] = value;
    }
}
if (platformUrl !== undefined && platformUrl !== "" && runnerToken !== undefined && runnerToken !== "") {
    // One sandbox per runner/host; Claude creds are NOT held here — the platform injects them per turn.
    const controller = createController({
        spec: {
            project: process.env["PROJECT_ID"] ?? "workspace",
            image: process.env["SANDBOX_IMAGE"] ?? "",
            network: "intentic-workspace",
            devCommand: process.env["DEV_COMMAND"] ?? "pnpm dev",
            devPort,
            daemonPort,
            ...(zone !== "" ? { zone } : {}),
            agentEnv: sandboxEnv,
        },
    });
    connectChannel({
        url: platformUrl,
        token: runnerToken,
        controller,
        signal: new AbortController().signal,
        log: (message) => process.stdout.write(`${message}\n`),
    });
    process.stdout.write(`intentic runner: dialing control plane at ${platformUrl}\n`);
} else {
    process.stdout.write("intentic runner: preview-only (no PLATFORM_URL/RUNNER_TOKEN)\n");
}
