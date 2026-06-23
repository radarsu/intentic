import { z } from "zod";
import { parseResponse } from "./inputs.js";

// One ingress rule of a Cloudflare Tunnel: a public hostname routed to an internal service URL, or the
// trailing catch-all (no hostname, service "http_status:404"). The provider owns the catch-all policy.
export interface IngressRule {
    readonly hostname?: string;
    readonly service: string;
}

const ingressRuleSchema = z.object({ hostname: z.string().optional(), service: z.string() });

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
    // Delete a tunnel by id. The engine has no destroy path; this exists so the e2e harness can purge the
    // live Cloudflare resources it created during teardown.
    readonly deleteTunnel: (args: { readonly accountId: string; readonly apiToken: string; readonly tunnelId: string }) => Promise<void>;
    // Delete a DNS record by id, for the same teardown purpose.
    readonly deleteDnsRecord: (args: { readonly apiToken: string; readonly zoneId: string; readonly recordId: string }) => Promise<void>;
}

const BASE = "https://api.cloudflare.com/client/v4";

// The Cloudflare success envelope. `result` is validated per-call against the shape we consume; here it is
// left unknown so an error envelope (success:false) still surfaces its `errors` rather than failing the
// result schema first.
const envelopeSchema = z.object({
    success: z.boolean(),
    errors: z.array(z.object({ code: z.number(), message: z.string() })),
    result: z.unknown(),
});

const call = async <S extends z.ZodType>(apiToken: string, path: string, resultSchema: S, init?: RequestInit): Promise<z.infer<S>> => {
    const method = init?.method ?? "GET";
    const label = `Cloudflare API ${method} ${path}`;
    const response = await fetch(`${BASE}${path}`, {
        ...init,
        headers: {
            Authorization: `Bearer ${apiToken}`,
            ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
    });
    const envelope = parseResponse(envelopeSchema, await response.json(), label);
    if (!response.ok || !envelope.success) {
        const detail = envelope.errors.map((error) => `${error.code} ${error.message}`).join("; ");
        throw new Error(`${label} failed (HTTP ${response.status}): ${detail}`);
    }
    return parseResponse(resultSchema, envelope.result, label);
};

export const cloudflareApi: CloudflareApi = {
    getZone: async ({ accountId, apiToken, zone }) => {
        const zones = await call(
            apiToken,
            `/zones?name=${encodeURIComponent(zone)}&account.id=${encodeURIComponent(accountId)}`,
            z.array(z.object({ id: z.string() })),
        );
        const found = zones[0];
        if (found === undefined) {
            return undefined;
        }
        return { id: found.id };
    },
    findTunnel: async ({ accountId, apiToken, name }) => {
        const tunnels = await call(
            apiToken,
            `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel?name=${encodeURIComponent(name)}&is_deleted=false`,
            z.array(z.object({ id: z.string() })),
        );
        const found = tunnels[0];
        if (found === undefined) {
            return undefined;
        }
        return { id: found.id };
    },
    createTunnel: ({ accountId, apiToken, name }) =>
        call(apiToken, `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel`, z.object({ id: z.string() }), {
            method: "POST",
            body: JSON.stringify({ name, config_src: "cloudflare" }),
        }),
    getTunnelToken: ({ accountId, apiToken, tunnelId }) =>
        call(apiToken, `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/token`, z.string()),
    getTunnelIngress: async ({ accountId, apiToken, tunnelId }) => {
        const config = await call(
            apiToken,
            `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/configurations`,
            z.object({ config: z.object({ ingress: z.array(ingressRuleSchema).optional() }).optional() }).nullable(),
        );
        const ingress = config?.config?.ingress;
        return ingress?.map((rule) => (rule.hostname === undefined ? { service: rule.service } : { hostname: rule.hostname, service: rule.service }));
    },
    putTunnelIngress: async ({ accountId, apiToken, tunnelId, ingress }) => {
        await call(apiToken, `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/configurations`, z.unknown(), {
            method: "PUT",
            body: JSON.stringify({ config: { ingress } }),
        });
    },
    findDnsRecord: async ({ apiToken, zoneId, name }) => {
        const records = await call(
            apiToken,
            `/zones/${encodeURIComponent(zoneId)}/dns_records?type=CNAME&name=${encodeURIComponent(name)}`,
            z.array(z.object({ id: z.string(), content: z.string() })),
        );
        const found = records[0];
        if (found === undefined) {
            return undefined;
        }
        return { id: found.id, content: found.content };
    },
    createDnsRecord: async ({ apiToken, zoneId, name, content, comment }) => {
        await call(apiToken, `/zones/${encodeURIComponent(zoneId)}/dns_records`, z.unknown(), {
            method: "POST",
            body: JSON.stringify({ type: "CNAME", name, content, proxied: true, comment }),
        });
    },
    updateDnsRecord: async ({ apiToken, zoneId, recordId, name, content, comment }) => {
        await call(apiToken, `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`, z.unknown(), {
            method: "PUT",
            body: JSON.stringify({ type: "CNAME", name, content, proxied: true, comment }),
        });
    },
    deleteTunnel: async ({ accountId, apiToken, tunnelId }) => {
        await call(apiToken, `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}`, z.unknown(), {
            method: "DELETE",
        });
    },
    deleteDnsRecord: async ({ apiToken, zoneId, recordId }) => {
        await call(apiToken, `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`, z.unknown(), {
            method: "DELETE",
        });
    },
};
