import type { Provider, ProviderContext, ResolvedInputs } from "@intentic/engine";
import { z } from "zod";
import type { CloudflareApi, IngressRule } from "./cloudflare-api.js";
import { cloudflareApi } from "./cloudflare-api.js";
import { parseInputs, sshSchema, sshTarget } from "./inputs.js";
import type { SshExecutor, SshSession } from "./ssh.js";
import { sshExecutor } from "./ssh.js";

const tunnelSchema = sshSchema.extend({
    name: z.string(),
    accountId: z.string(),
    apiToken: z.string(),
    internalIp: z.string(),
    ingress: z.array(z.object({ hostname: z.string(), port: z.coerce.number() })),
    // The pinned cloudflared image. The connector is stateless, so a version bump just recreates it.
    image: z.string(),
});
type TunnelInputs = z.infer<typeof tunnelSchema>;
const parse = (inputs: ResolvedInputs): TunnelInputs => parseInputs(tunnelSchema, inputs, "tunnel");

// Cloudflare requires every ingress list to end with a catch-all rule (no hostname). The provider owns
// this policy so the API adapter stays a dumb transport.
const CATCH_ALL: IngressRule = { service: "http_status:404" };

// Each public hostname routes to a service on the host's internal ip at its fixed port; cloudflared dials
// these over --network host. The full desired rule set ends with the catch-all.
const desiredRules = (parsed: TunnelInputs): IngressRule[] => [
    ...parsed.ingress.map((rule) => ({ hostname: rule.hostname, service: `http://${parsed.internalIp}:${rule.port}` })),
    CATCH_ALL,
];

const cname = (tunnelId: string): string => `${tunnelId}.cfargotunnel.com`;
const containerName = (tunnelId: string): string => `intentic-tunnel-${tunnelId}`;

const ingressEqual = (a: readonly IngressRule[], b: readonly IngressRule[]): boolean => {
    if (a.length !== b.length) {
        return false;
    }
    return a.every((rule, index) => {
        const other = b[index];
        return other !== undefined && rule.hostname === other.hostname && rule.service === other.service;
    });
};

// Is the cloudflared connector running on the host, and on which image? A read-only SSH check; a host that
// is not reachable is reported as not-running (and logged) so a plan proceeds rather than aborting — apply
// will surface the connection failure as a hard error. The image lets diff recreate on a version bump.
const checkConnector = async (
    executor: SshExecutor,
    parsed: TunnelInputs,
    tunnelId: string,
    ctx: ProviderContext,
): Promise<{ running: boolean; image: string | undefined }> => {
    let session: SshSession;
    try {
        session = await executor.connect(sshTarget(parsed));
    } catch (error) {
        ctx.log(`tunnel "${ctx.id}": host not reachable over SSH to check the connector: ${String(error)}`);
        return { running: false, image: undefined };
    }
    try {
        const name = containerName(tunnelId);
        const result = await session.exec(`docker ps --filter "name=^${name}$" --format '{{.Names}}'`);
        if (result.stdout.trim() !== name) {
            return { running: false, image: undefined };
        }
        const image = (await session.exec(`docker inspect --format '{{.Config.Image}}' ${name} 2>/dev/null || true`)).stdout.trim();
        return { running: true, image };
    } finally {
        await session.dispose();
    }
};

// (Re)start the cloudflared connector on the host. Idempotent: remove any prior container, then run a
// fresh one — the connector is stateless (its ingress lives in Cloudflare). --network host lets it dial
// the services' internal urls. A connection failure propagates as the hard error for an unreachable host.
const runConnector = async (executor: SshExecutor, parsed: TunnelInputs, tunnelId: string, token: string): Promise<void> => {
    const session = await executor.connect(sshTarget(parsed));
    try {
        const name = containerName(tunnelId);
        await session.exec(`docker rm -f ${name} 2>/dev/null || true`);
        const run = await session.exec(
            `docker run -d --restart unless-stopped --network host --name ${name} ${parsed.image} tunnel --no-autoupdate run --token ${token}`,
        );
        if (run.code !== 0) {
            throw new Error(`failed to start cloudflared on host: exited ${run.code}: ${run.stderr.trim()}`);
        }
    } finally {
        await session.dispose();
    }
};

// The Cloudflare Tunnel for one host: a remotely-managed cfd_tunnel whose connector (cloudflared) runs on
// the host and whose ingress maps the host's public hostnames to their internal service urls. read finds
// the tunnel and surfaces the actual ingress + connector state via detail so the pure diff can detect
// drift; apply ensures the tunnel exists, the connector runs, and the ingress matches.
export const createTunnelProvider = (api: CloudflareApi = cloudflareApi, executor: SshExecutor = sshExecutor): Provider => ({
    read: async (inputs, ctx) => {
        const parsed = parse(inputs);
        const tunnel = await api.findTunnel({ accountId: parsed.accountId, apiToken: parsed.apiToken, name: parsed.name });
        if (tunnel === undefined) {
            return undefined;
        }
        const ingress = await api.getTunnelIngress({ accountId: parsed.accountId, apiToken: parsed.apiToken, tunnelId: tunnel.id });
        const connector = await checkConnector(executor, parsed, tunnel.id, ctx);
        return {
            outputs: { tunnelId: tunnel.id, cname: cname(tunnel.id) },
            detail: { ingress: ingress ?? [], connectorRunning: connector.running, image: connector.image },
        };
    },
    diff: (inputs, observed) => {
        const parsed = parse(inputs);
        const detail = observed.detail;
        if (detail === undefined || detail["connectorRunning"] !== true) {
            return { action: "update", reason: "cloudflared connector is not running on the host" };
        }
        if (detail["image"] !== parsed.image) {
            return { action: "update", reason: `cloudflared image differs (running ${String(detail["image"])}, want ${parsed.image})` };
        }
        const current = detail["ingress"];
        const actual = Array.isArray(current) ? (current as IngressRule[]) : [];
        if (!ingressEqual(actual, desiredRules(parsed))) {
            return { action: "update", reason: "tunnel ingress differs from desired" };
        }
        return { action: "noop" };
    },
    apply: async (inputs) => {
        const parsed = parse(inputs);
        const existing = await api.findTunnel({ accountId: parsed.accountId, apiToken: parsed.apiToken, name: parsed.name });
        const tunnel = existing ?? (await api.createTunnel({ accountId: parsed.accountId, apiToken: parsed.apiToken, name: parsed.name }));
        const token = await api.getTunnelToken({ accountId: parsed.accountId, apiToken: parsed.apiToken, tunnelId: tunnel.id });
        // Set the ingress in Cloudflare BEFORE (re)starting the connector: a remotely-managed cloudflared
        // fetches its config on startup, so a connector started before the ingress exists serves only the
        // catch-all 404. runConnector always recreates the container, so it picks up the ingress just PUT.
        await api.putTunnelIngress({
            accountId: parsed.accountId,
            apiToken: parsed.apiToken,
            tunnelId: tunnel.id,
            ingress: desiredRules(parsed),
        });
        await runConnector(executor, parsed, tunnel.id, token);
        return { tunnelId: tunnel.id, cname: cname(tunnel.id) };
    },
    delete: async (inputs) => {
        const parsed = parse(inputs);
        const tunnel = await api.findTunnel({ accountId: parsed.accountId, apiToken: parsed.apiToken, name: parsed.name });
        if (tunnel === undefined) {
            return;
        }
        // Remove the host connector first, then delete the (now-disconnected) tunnel in Cloudflare.
        const session = await executor.connect(sshTarget(parsed));
        try {
            await session.exec(`docker rm -f ${containerName(tunnel.id)} 2>/dev/null || true`);
        } finally {
            await session.dispose();
        }
        await api.deleteTunnel({ accountId: parsed.accountId, apiToken: parsed.apiToken, tunnelId: tunnel.id });
    },
});
