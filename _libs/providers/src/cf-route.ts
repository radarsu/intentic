import type { Provider, ResolvedInputs } from "@intentic/engine";
import { formatStamp } from "@intentic/graph";
import { z } from "zod";
import type { CloudflareApi } from "./cloudflare-api.js";
import { cloudflareApi } from "./cloudflare-api.js";
import { parseInputs } from "./inputs.js";

const cfRouteSchema = z.object({ hostname: z.string(), zoneId: z.string(), apiToken: z.string(), cname: z.string() });
const parse = (inputs: ResolvedInputs): z.infer<typeof cfRouteSchema> => parseInputs(cfRouteSchema, inputs, "cf-route");

// Wait until a freshly-created proxied record is globally resolvable BEFORE any downstream provider (repo,
// app, deployment) resolves the hostname. This matters because the control-plane providers hit the public
// url from wherever the CLI runs: if they resolve the name during its propagation window the lookup fails
// AND the resolver caches NXDOMAIN for the zone's SOA negative-TTL (30 min on a Cloudflare zone), wedging
// every later attempt. We probe over DoH (an HTTPS call to Cloudflare's resolver) rather than the OS
// resolver, precisely so this readiness check never pollutes the cache the consumers depend on. Best-effort:
// if DoH itself is unreachable we log and proceed rather than block the apply.
export type DnsPropagationWait = (hostname: string, log: (message: string) => void) => Promise<void>;

const dohResolves = async (hostname: string): Promise<boolean> => {
    try {
        const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`, {
            headers: { accept: "application/dns-json" },
        });
        if (!response.ok) {
            return false;
        }
        const body = (await response.json()) as { readonly Status?: number; readonly Answer?: readonly unknown[] };
        return body.Status === 0 && Array.isArray(body.Answer) && body.Answer.length > 0;
    } catch {
        return false;
    }
};

const waitForDnsPropagation: DnsPropagationWait = async (hostname, log) => {
    const deadline = Date.now() + 90_000;
    for (;;) {
        if (await dohResolves(hostname)) {
            return;
        }
        if (Date.now() >= deadline) {
            log(`cf-route: ${hostname} not yet observable via DoH after 90s; proceeding (downstream calls may need a retry)`);
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
    }
};

// A cf-route owns one public hostname's proxied DNS CNAME pointing at the host tunnel's cfargotunnel
// hostname (the tunnel owns the ingress mapping the hostname to the internal service). read returns the
// route if a CNAME for the hostname exists, surfacing its current target via detail; diff reports drift
// when that target differs from the tunnel cname; apply upserts the proxied CNAME (stamped so it is
// attributable) and waits for it to propagate. The url output is derived from the hostname.
export const createCfRouteProvider = (
    api: CloudflareApi = cloudflareApi,
    awaitPropagation: DnsPropagationWait = waitForDnsPropagation,
): Provider => ({
    read: async (inputs) => {
        const { hostname, zoneId, apiToken } = parse(inputs);
        const record = await api.findDnsRecord({ apiToken, zoneId, name: hostname });
        if (record === undefined) {
            return undefined;
        }
        return { outputs: { url: `https://${hostname}` }, detail: { content: record.content } };
    },
    diff: (inputs, observed) => {
        const { cname } = parse(inputs);
        const content = observed.detail?.["content"];
        if (content === cname) {
            return { action: "noop" };
        }
        return { action: "update", reason: `CNAME target "${String(content)}" differs from "${cname}"` };
    },
    apply: async (inputs, _observed, ctx) => {
        const { hostname, zoneId, apiToken, cname } = parse(inputs);
        const comment = formatStamp(ctx.id);
        const record = await api.findDnsRecord({ apiToken, zoneId, name: hostname });
        if (record === undefined) {
            await api.createDnsRecord({ apiToken, zoneId, name: hostname, content: cname, comment });
        } else {
            await api.updateDnsRecord({ apiToken, zoneId, recordId: record.id, name: hostname, content: cname, comment });
        }
        await awaitPropagation(hostname, ctx.log);
        return { url: `https://${hostname}` };
    },
});
