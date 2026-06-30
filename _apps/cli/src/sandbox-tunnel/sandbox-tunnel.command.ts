import { buildCommand, type CommandContext } from "@stricli/core";
import { createSandboxTunnel } from "./sandbox-tunnel.js";

// Used by the sandbox bootstrap (connect.sh / the workspace provider), not operators directly: stand up the
// per-sandbox Cloudflare tunnel + DNS that exposes the daemon at sandbox-<id>.<zone>, reusing the providers'
// Cloudflare client. Prints `TUNNEL_TOKEN=…` / `SANDBOX_HOSTNAME=…` on stdout (progress on stderr) so the
// bootstrap can capture them and run cloudflared. Run inside the sandbox image (which carries this CLI).
export const sandboxTunnel = buildCommand<{ service: string; previewService?: string; zone?: string }>({
    docs: { brief: "Create/refresh the per-sandbox Cloudflare tunnel + DNS and print its connector token (used by connect.sh)" },
    parameters: {
        flags: {
            service: {
                kind: "parsed",
                parse: String,
                brief: "Internal service URL the tunnel routes to (e.g. http://intentic-sandbox-workspace:8787)",
            },
            previewService: {
                kind: "parsed",
                parse: String,
                optional: true,
                brief: "Dev-server URL to route the *.preview.<zone> wildcard to (e.g. http://intentic-sandbox-workspace:5173)",
            },
            zone: {
                kind: "parsed",
                parse: String,
                optional: true,
                brief: "Cloudflare zone for the DNS record (default: the API token's sole zone, or set ZONE)",
            },
        },
    },
    async func(this: CommandContext, flags: { service: string; previewService?: string; zone?: string }) {
        const apiToken = process.env["CLOUDFLARE_API_TOKEN"];
        const connectToken = process.env["CONNECT_TOKEN"];
        if (apiToken === undefined || apiToken === "") {
            throw new Error("set CLOUDFLARE_API_TOKEN");
        }
        if (connectToken === undefined || connectToken === "") {
            throw new Error("set CONNECT_TOKEN (the per-sandbox connection token)");
        }
        const zone = flags.zone ?? process.env["ZONE"];
        const { token, hostname } = await createSandboxTunnel({
            apiToken,
            connectToken,
            service: flags.service,
            ...(flags.previewService !== undefined && flags.previewService !== "" ? { previewService: flags.previewService } : {}),
            ...(zone !== undefined && zone !== "" ? { zone } : {}),
            log: (message) => this.process.stderr.write(`${message}\n`),
        });
        // Machine-readable on stdout for connect.sh to capture (progress went to stderr).
        this.process.stdout.write(`TUNNEL_TOKEN=${token}\nSANDBOX_HOSTNAME=${hostname}\n`);
    },
});
