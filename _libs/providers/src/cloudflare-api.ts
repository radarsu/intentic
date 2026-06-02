// One ingress rule of a Cloudflare Tunnel: a public hostname routed to an internal service URL, or the
// trailing catch-all (no hostname, service "http_status:404"). The provider owns the catch-all policy.
export interface IngressRule {
    readonly hostname?: string;
    readonly service: string;
}

// The Cloudflare v4 REST surface the providers use, injected so the providers are unit-testable with a
// fake; the default `cloudflareApi` below talks to api.cloudflare.com over native fetch. Auth flows
// per-call (the bearer token is a resolved node input), never baked into the adapter at construction.
export interface CloudflareApi {
    // Resolve an OWNED zone by name within an account; undefined if no such zone exists.
    readonly getZone: (args: {
        readonly accountId: string;
        readonly apiToken: string;
        readonly zone: string;
    }) => Promise<{ readonly id: string } | undefined>;
    // Find a cloudflared tunnel by exact name (excluding soft-deleted); undefined if none.
    readonly findTunnel: (args: {
        readonly accountId: string;
        readonly apiToken: string;
        readonly name: string;
    }) => Promise<{ readonly id: string } | undefined>;
    // Create a remotely-managed (config_src "cloudflare") tunnel; returns its id.
    readonly createTunnel: (args: {
        readonly accountId: string;
        readonly apiToken: string;
        readonly name: string;
    }) => Promise<{ readonly id: string }>;
    // The connector token used to run cloudflared on the host.
    readonly getTunnelToken: (args: { readonly accountId: string; readonly apiToken: string; readonly tunnelId: string }) => Promise<string>;
    // The tunnel's current ingress; undefined if no configuration has been set yet.
    readonly getTunnelIngress: (args: {
        readonly accountId: string;
        readonly apiToken: string;
        readonly tunnelId: string;
    }) => Promise<IngressRule[] | undefined>;
    // Replace the tunnel's ingress with exactly the rules given (the caller appends the catch-all).
    readonly putTunnelIngress: (args: {
        readonly accountId: string;
        readonly apiToken: string;
        readonly tunnelId: string;
        readonly ingress: readonly IngressRule[];
    }) => Promise<void>;
    // Find a CNAME record by exact name in a zone; undefined if none.
    readonly findDnsRecord: (args: {
        readonly apiToken: string;
        readonly zoneId: string;
        readonly name: string;
    }) => Promise<{ readonly id: string; readonly content: string } | undefined>;
    // Create a proxied CNAME stamped with the given comment.
    readonly createDnsRecord: (args: {
        readonly apiToken: string;
        readonly zoneId: string;
        readonly name: string;
        readonly content: string;
        readonly comment: string;
    }) => Promise<void>;
    // Replace a CNAME record (overwrites type/content/proxied) keeping the stamp.
    readonly updateDnsRecord: (args: {
        readonly apiToken: string;
        readonly zoneId: string;
        readonly recordId: string;
        readonly name: string;
        readonly content: string;
        readonly comment: string;
    }) => Promise<void>;
}

const BASE = "https://api.cloudflare.com/client/v4";

interface Envelope<T> {
    readonly success: boolean;
    readonly errors: ReadonlyArray<{ readonly code: number; readonly message: string }>;
    readonly result: T;
}

const call = async <T>(apiToken: string, path: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(`${BASE}${path}`, {
        ...init,
        headers: {
            Authorization: `Bearer ${apiToken}`,
            ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
    });
    const body = (await response.json()) as Envelope<T>;
    if (!response.ok || !body.success) {
        const detail = body.errors.map((error) => `${error.code} ${error.message}`).join("; ");
        throw new Error(`Cloudflare API ${init?.method ?? "GET"} ${path} failed (HTTP ${response.status}): ${detail}`);
    }
    return body.result;
};

export const cloudflareApi: CloudflareApi = {
    getZone: async ({ accountId, apiToken, zone }) => {
        const zones = await call<ReadonlyArray<{ id: string }>>(
            apiToken,
            `/zones?name=${encodeURIComponent(zone)}&account.id=${encodeURIComponent(accountId)}`,
        );
        const found = zones[0];
        if (found === undefined) {
            return undefined;
        }
        return { id: found.id };
    },
    findTunnel: async ({ accountId, apiToken, name }) => {
        const tunnels = await call<ReadonlyArray<{ id: string }>>(
            apiToken,
            `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel?name=${encodeURIComponent(name)}&is_deleted=false`,
        );
        const found = tunnels[0];
        if (found === undefined) {
            return undefined;
        }
        return { id: found.id };
    },
    createTunnel: ({ accountId, apiToken, name }) =>
        call<{ id: string }>(apiToken, `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel`, {
            method: "POST",
            body: JSON.stringify({ name, config_src: "cloudflare" }),
        }),
    getTunnelToken: ({ accountId, apiToken, tunnelId }) =>
        call<string>(apiToken, `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/token`),
    getTunnelIngress: async ({ accountId, apiToken, tunnelId }) => {
        const config = await call<{ config?: { ingress?: IngressRule[] } } | null>(
            apiToken,
            `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/configurations`,
        );
        return config?.config?.ingress;
    },
    putTunnelIngress: async ({ accountId, apiToken, tunnelId, ingress }) => {
        await call(apiToken, `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/configurations`, {
            method: "PUT",
            body: JSON.stringify({ config: { ingress } }),
        });
    },
    findDnsRecord: async ({ apiToken, zoneId, name }) => {
        const records = await call<ReadonlyArray<{ id: string; content: string }>>(
            apiToken,
            `/zones/${encodeURIComponent(zoneId)}/dns_records?type=CNAME&name=${encodeURIComponent(name)}`,
        );
        const found = records[0];
        if (found === undefined) {
            return undefined;
        }
        return { id: found.id, content: found.content };
    },
    createDnsRecord: async ({ apiToken, zoneId, name, content, comment }) => {
        await call(apiToken, `/zones/${encodeURIComponent(zoneId)}/dns_records`, {
            method: "POST",
            body: JSON.stringify({ type: "CNAME", name, content, proxied: true, comment }),
        });
    },
    updateDnsRecord: async ({ apiToken, zoneId, recordId, name, content, comment }) => {
        await call(apiToken, `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`, {
            method: "PUT",
            body: JSON.stringify({ type: "CNAME", name, content, proxied: true, comment }),
        });
    },
};
