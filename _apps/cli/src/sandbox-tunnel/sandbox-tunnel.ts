import { createHash } from "node:crypto";
import { type CloudflareApi, cloudflareApi } from "@intentic/providers";
import { CATCH_ALL, resolveZone, upsertCname } from "../lib/cf-tunnel.js";

export interface SandboxTunnelResult {
    readonly token: string;
    readonly hostname: string;
}

// Create (or refresh, idempotently) the per-sandbox Cloudflare tunnel + proxied DNS record that exposes the
// sandbox daemon at `sandbox-<id>.<zone>`, and return the connector token connect.sh runs cloudflared with.
// `<id>` is a stable, unguessable digest of the connection token, so re-runs reuse the same tunnel/hostname.
// Reuses the providers' Cloudflare client — the same REST surface `intentic apply` uses for platform tunnels.
export const createSandboxTunnel = async (args: {
    readonly apiToken: string;
    readonly connectToken: string;
    readonly service: string;
    // When set, also route the app preview wildcard `*.preview.<zone>` straight to the sandbox's dev server.
    readonly previewService?: string;
    readonly zone?: string;
    // An explicit subdomain prefix chosen by the own-Cloudflare user; default is the derived `sandbox-<id>`.
    readonly subdomain?: string;
    readonly log: (message: string) => void;
    readonly api?: CloudflareApi;
}): Promise<SandboxTunnelResult> => {
    const { apiToken, connectToken, service, previewService, log } = args;
    const api = args.api ?? cloudflareApi;
    const zone = await resolveZone(api, apiToken, args.zone);
    const id = createHash("sha256").update(connectToken).digest("hex").slice(0, 12);
    const name = args.subdomain !== undefined && args.subdomain !== "" ? args.subdomain : `sandbox-${id}`;
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
    await upsertCname(api, apiToken, zone.id, hostname, cname, "intentic sandbox tunnel");
    if (withPreview) {
        await upsertCname(api, apiToken, zone.id, previewHostname, cname, "intentic sandbox tunnel");
    }
    log(`tunnel "${name}" → ${hostname} ready`);
    return { token, hostname };
};
