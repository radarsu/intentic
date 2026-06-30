import { createHash } from "node:crypto";
import { type CloudflareApi, cloudflareApi } from "@intentic/providers";

// The trailing catch-all rule cloudflared requires (mirrors the tunnel provider's CATCH_ALL).
const CATCH_ALL = { service: "http_status:404" } as const;

export interface SandboxTunnelResult {
    readonly token: string;
    readonly hostname: string;
}

// Resolve the zone (id + account) the sandbox hostname lives under: an explicit override (getZone), else the
// token's sole zone — erroring when the token sees none or several (the operator must then set ZONE).
const resolveZone = async (api: CloudflareApi, apiToken: string, override: string | undefined): Promise<{ id: string; name: string; accountId: string }> => {
    if (override !== undefined && override !== "") {
        const found = await api.getZone({ apiToken, zone: override });
        if (found === undefined) {
            throw new Error(`Cloudflare zone "${override}" not found for this API token`);
        }
        return { id: found.id, name: override, accountId: found.accountId };
    }
    const zones = await api.listZones({ apiToken });
    const [only, ...rest] = zones;
    if (only === undefined) {
        throw new Error("the Cloudflare API token sees no zones — add a zone to the account or set ZONE");
    }
    if (rest.length > 0) {
        throw new Error(`the API token sees multiple zones (${[only, ...rest].map((zone) => zone.name).join(", ")}); set ZONE to choose one`);
    }
    return only;
};

// Create (or refresh, idempotently) the per-sandbox Cloudflare tunnel + proxied DNS record that exposes the
// sandbox daemon at `sandbox-<id>.<zone>`, and return the connector token connect.sh runs cloudflared with.
// `<id>` is a stable, unguessable digest of the connection token, so re-runs reuse the same tunnel/hostname.
// Reuses the providers' Cloudflare client — the same REST surface `intentic apply` uses for platform tunnels.
// Upsert a proxied CNAME `name` → `cname` (idempotent), stamped so it is attributable.
const upsertCname = async (api: CloudflareApi, apiToken: string, zoneId: string, name: string, cname: string): Promise<void> => {
    const comment = "intentic sandbox tunnel";
    const record = await api.findDnsRecord({ apiToken, zoneId, name });
    if (record === undefined) {
        await api.createDnsRecord({ apiToken, zoneId, name, content: cname, comment });
    } else {
        await api.updateDnsRecord({ apiToken, zoneId, recordId: record.id, name, content: cname, comment });
    }
};

export const createSandboxTunnel = async (args: {
    readonly apiToken: string;
    readonly connectToken: string;
    readonly service: string;
    // When set, also route the app preview wildcard `*.preview.<zone>` here (the runner's preview proxy is gone).
    readonly previewService?: string;
    readonly zone?: string;
    readonly log: (message: string) => void;
    readonly api?: CloudflareApi;
}): Promise<SandboxTunnelResult> => {
    const { apiToken, connectToken, service, previewService, log } = args;
    const api = args.api ?? cloudflareApi;
    const zone = await resolveZone(api, apiToken, args.zone);
    const id = createHash("sha256").update(connectToken).digest("hex").slice(0, 12);
    const name = `sandbox-${id}`;
    const hostname = `${name}.${zone.name}`;
    const previewHostname = `*.preview.${zone.name}`;
    const withPreview = previewService !== undefined && previewService !== "";
    log(`resolving tunnel "${name}" on zone "${zone.name}"…`);
    const existing = await api.findTunnel({ accountId: zone.accountId, apiToken, name });
    const tunnel = existing ?? (await api.createTunnel({ accountId: zone.accountId, apiToken, name }));
    const token = await api.getTunnelToken({ accountId: zone.accountId, apiToken, tunnelId: tunnel.id });
    const ingress = [{ hostname, service }, ...(withPreview ? [{ hostname: previewHostname, service: previewService }] : []), CATCH_ALL];
    await api.putTunnelIngress({ accountId: zone.accountId, apiToken, tunnelId: tunnel.id, ingress });
    const cname = `${tunnel.id}.cfargotunnel.com`;
    await upsertCname(api, apiToken, zone.id, hostname, cname);
    if (withPreview) {
        await upsertCname(api, apiToken, zone.id, previewHostname, cname);
    }
    log(`tunnel "${name}" → ${hostname} ready`);
    return { token, hostname };
};
