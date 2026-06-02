import type { Provider, ProviderContext, ResolvedInputs } from "@puristic/deploy-engine";
import type { CloudflareApi, IngressRule } from "./cloudflare-api.js";
import { cloudflareApi } from "./cloudflare-api.js";
import type { SshExecutor, SshSession, SshTarget } from "./ssh.js";
import { sshExecutor } from "./ssh.js";

interface TunnelInputs {
    readonly name: string;
    readonly accountId: string;
    readonly apiToken: string;
    readonly address: string;
    readonly user: string;
    readonly privateKey: string;
    readonly port: number;
    readonly ingress: IngressRule[];
}

// Cloudflare requires every ingress list to end with a catch-all rule (no hostname). The provider owns
// this policy so the API adapter stays a dumb transport.
const CATCH_ALL: IngressRule = { service: "http_status:404" };
const withCatchAll = (rules: readonly IngressRule[]): IngressRule[] => [...rules, CATCH_ALL];

const cname = (tunnelId: string): string => `${tunnelId}.cfargotunnel.com`;
const containerName = (tunnelId: string): string => `puristic-tunnel-${tunnelId}`;
const sshTarget = (parsed: TunnelInputs): SshTarget => ({
    address: parsed.address,
    user: parsed.user,
    privateKey: parsed.privateKey,
    port: parsed.port,
});

const parseIngress = (value: unknown): IngressRule[] => {
    if (!Array.isArray(value)) {
        throw new Error(`tunnel input "ingress" must be an array (got ${typeof value})`);
    }
    const rules: IngressRule[] = [];
    for (const entry of value) {
        if (typeof entry !== "object" || entry === null) {
            throw new Error(`tunnel ingress entry must be an object (got ${typeof entry})`);
        }
        const record = entry as Record<string, unknown>;
        const hostname = record["hostname"];
        const service = record["service"];
        if (typeof hostname !== "string" || typeof service !== "string") {
            throw new Error(`tunnel ingress entry must have string hostname/service (got ${typeof hostname}/${typeof service})`);
        }
        rules.push({ hostname, service });
    }
    return rules;
};

const parseTunnelInputs = (inputs: ResolvedInputs): TunnelInputs => {
    const name = inputs["name"];
    const accountId = inputs["accountId"];
    const apiToken = inputs["apiToken"];
    const address = inputs["address"];
    const user = inputs["user"];
    const sshKey = inputs["sshKey"];
    const port = inputs["port"];
    if (
        typeof name !== "string" ||
        typeof accountId !== "string" ||
        typeof apiToken !== "string" ||
        typeof address !== "string" ||
        typeof user !== "string" ||
        typeof sshKey !== "string"
    ) {
        throw new Error("tunnel inputs malformed: name/accountId/apiToken/address/user/sshKey must be strings");
    }
    if (port !== undefined && typeof port !== "number") {
        throw new Error(`tunnel input "port" must be a number when present (got ${typeof port})`);
    }
    return { name, accountId, apiToken, address, user, privateKey: sshKey, port: port ?? 22, ingress: parseIngress(inputs["ingress"]) };
};

const ingressEqual = (a: readonly IngressRule[], b: readonly IngressRule[]): boolean => {
    if (a.length !== b.length) {
        return false;
    }
    return a.every((rule, index) => {
        const other = b[index];
        return other !== undefined && rule.hostname === other.hostname && rule.service === other.service;
    });
};

// Is the cloudflared connector container running on the host? A read-only SSH check; a host that is not
// reachable is reported as not-running (and logged) so a plan proceeds rather than aborting — apply will
// surface the connection failure as a hard error.
const checkConnector = async (executor: SshExecutor, parsed: TunnelInputs, tunnelId: string, ctx: ProviderContext): Promise<boolean> => {
    let session: SshSession;
    try {
        session = await executor.connect(sshTarget(parsed));
    } catch (error) {
        ctx.log(`tunnel "${ctx.id}": host not reachable over SSH to check the connector: ${String(error)}`);
        return false;
    }
    try {
        const name = containerName(tunnelId);
        const result = await session.exec(`docker ps --filter "name=^${name}$" --format '{{.Names}}'`);
        return result.stdout.trim() === name;
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
            `docker run -d --restart unless-stopped --network host --name ${name} cloudflare/cloudflared:latest tunnel --no-autoupdate run --token ${token}`,
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
        const parsed = parseTunnelInputs(inputs);
        const tunnel = await api.findTunnel({ accountId: parsed.accountId, apiToken: parsed.apiToken, name: parsed.name });
        if (tunnel === undefined) {
            return undefined;
        }
        const ingress = await api.getTunnelIngress({ accountId: parsed.accountId, apiToken: parsed.apiToken, tunnelId: tunnel.id });
        const connectorRunning = await checkConnector(executor, parsed, tunnel.id, ctx);
        return { outputs: { tunnelId: tunnel.id, cname: cname(tunnel.id) }, detail: { ingress: ingress ?? [], connectorRunning } };
    },
    diff: (inputs, observed) => {
        const parsed = parseTunnelInputs(inputs);
        const detail = observed.detail;
        if (detail === undefined || detail["connectorRunning"] !== true) {
            return { action: "update", reason: "cloudflared connector is not running on the host" };
        }
        const current = detail["ingress"];
        const actual = Array.isArray(current) ? (current as IngressRule[]) : [];
        if (!ingressEqual(actual, withCatchAll(parsed.ingress))) {
            return { action: "update", reason: "tunnel ingress differs from desired" };
        }
        return { action: "noop" };
    },
    apply: async (inputs) => {
        const parsed = parseTunnelInputs(inputs);
        const existing = await api.findTunnel({ accountId: parsed.accountId, apiToken: parsed.apiToken, name: parsed.name });
        const tunnel = existing ?? (await api.createTunnel({ accountId: parsed.accountId, apiToken: parsed.apiToken, name: parsed.name }));
        const token = await api.getTunnelToken({ accountId: parsed.accountId, apiToken: parsed.apiToken, tunnelId: tunnel.id });
        await runConnector(executor, parsed, tunnel.id, token);
        await api.putTunnelIngress({
            accountId: parsed.accountId,
            apiToken: parsed.apiToken,
            tunnelId: tunnel.id,
            ingress: withCatchAll(parsed.ingress),
        });
        return { tunnelId: tunnel.id, cname: cname(tunnel.id) };
    },
});
