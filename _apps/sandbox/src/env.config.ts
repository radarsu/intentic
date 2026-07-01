import { type ConfigDefinition, cliArgs, env, loadConfig as loadPuristicConfig } from "@puristic/env/index.js";
import { z } from "zod";

// All sandbox configuration, from env set at `docker run` — by connect.sh (your PC) or the workspace provider
// (a server). @puristic/env derives each env var name from the schema path (camelToScreamingSnake per segment,
// joined with "_"): workspaceRoot → WORKSPACE_ROOT, sandbox.publicUrl → SANDBOX_PUBLIC_URL, selfHost.user →
// SELF_HOST_USER, intenticAgentTools → INTENTIC_AGENT_TOOLS, claudeCodeOauthToken → CLAUDE_CODE_OAUTH_TOKEN.
// These names are the fixed contract the connect scripts / providers set, so the schema shape preserves them.
const configSchema = z.object({
    // The project workspace dir; the three repos (intent / desired-state / app) are cloned under <root>/<role>.
    workspaceRoot: z.string().default("/work"),
    // pino level + whether to pretty-print (human-readable) instead of JSON — pretty only in dev.
    logLevel: z.string().default("info"),
    logPretty: z
        .string()
        .default("")
        .transform((value) => value === "true" || value === "1"),
    // Cloudflare zone for the scaffolded app's domain (else derived from the public URL's host minus its label).
    zone: z.string().default(""),
    // Presence gates self-host mode (the SSH key the deploy target uses); never read for its value here.
    hostSshKey: z.string().default("").meta({ secret: true }),
    // The first-bind connection token (TOFU owner gate) and the platform web origin scoped for CORS.
    connectToken: z.string().default("").meta({ secret: true }),
    webOrigin: z.string().default(""),
    // The platform base this sandbox registers its public URL against (decentralized directory; best-effort).
    platformUrl: z.string().default(""),
    // Intent-declared internal MCP tools (base64 JSON) the workspace provider set; constant for the sandbox.
    intenticAgentTools: z.string().default(""),
    // Container-env Claude fallback creds: used only to decide whether a turn can run when no account is stored.
    claudeCodeOauthToken: z.string().default("").meta({ secret: true }),
    anthropicApiKey: z.string().default("").meta({ secret: true }),
    sandbox: z
        .object({
            port: z.coerce.number().default(8787),
            // Binds 0.0.0.0 by default (reached over the tunnel / host-internal ip); override for local runs.
            host: z.string().default("0.0.0.0"),
            // This sandbox's public URL (set by connect.{sh,ps1} after the tunnel is created).
            publicUrl: z.string().default(""),
            // Identity for the platform's Connections card; both must be set to surface anything.
            name: z.string().default(""),
            image: z.string().default(""),
        })
        .prefault({}),
    dev: z
        .object({
            // The app's watch command (e.g. "pnpm dev") and the port it listens on; both empty ⇒ no dev server.
            command: z.string().default(""),
            port: z.string().default(""),
        })
        .prefault({}),
    google: z
        .object({
            // The Google *web* client id (public) — the audience the daemon verifies bearer ID tokens against.
            // Empty ⇒ loopback mode (no auth): tests, or the host-internal server preview.
            clientId: z.string().default(""),
        })
        .prefault({}),
    selfHost: z
        .object({
            // SSH user of the wired deploy target; empty (or no host key) ⇒ this sandbox has no self-host target.
            user: z.string().default(""),
            // Where the sandbox SSHes to deploy: with via "direct" the host it runs on (default
            // host.docker.internal, the host-gateway connect.sh maps); with via "cloudflared" the host's SSH
            // tunnel hostname (ssh-<id>.<zone>) connect.sh creates for a NAT'd self-host.
            address: z.string().default("host.docker.internal"),
            // SSH transport for the self host: "cloudflared" reaches `address` through its Cloudflare tunnel
            // (the sandbox runs `cloudflared access`), for a host it can't reach by IP (e.g. Docker Desktop).
            via: z.enum(["direct", "cloudflared"]).default("direct"),
        })
        .prefault({}),
});

// Export the raw definition (not loadConfig's result) so the purenv CLI + codegen can resolve it. Sources:
// real env first, CLI flags last (CLI wins), matching @puristic's precedence.
const definition = {
    schema: configSchema,
    sources: [env(), cliArgs()],
} satisfies ConfigDefinition<typeof configSchema>;

export default definition;

export type Config = z.infer<typeof configSchema>;

export const loadConfig = (): Config => loadPuristicConfig(definition);
