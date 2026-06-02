import type { Provider, ResolvedInputs } from "@puristic/deploy-engine";
import { formatStamp } from "@puristic/deploy-protocol";
import type { CloudflareApi } from "./cloudflare-api.js";
import { cloudflareApi } from "./cloudflare-api.js";

interface CfRouteInputs {
    readonly hostname: string;
    readonly zoneId: string;
    readonly apiToken: string;
    readonly cname: string;
}

const parseCfRouteInputs = (inputs: ResolvedInputs): CfRouteInputs => {
    const hostname = inputs["hostname"];
    const zoneId = inputs["zoneId"];
    const apiToken = inputs["apiToken"];
    const cname = inputs["cname"];
    if (typeof hostname !== "string" || typeof zoneId !== "string" || typeof apiToken !== "string" || typeof cname !== "string") {
        throw new Error(
            `cf-route inputs malformed: hostname/zoneId/apiToken/cname must be strings (got ${typeof hostname}/${typeof zoneId}/${typeof apiToken}/${typeof cname})`,
        );
    }
    return { hostname, zoneId, apiToken, cname };
};

// A cf-route owns one public hostname's proxied DNS CNAME pointing at the host tunnel's cfargotunnel
// hostname (the tunnel owns the ingress mapping the hostname to the internal service). read returns the
// route if a CNAME for the hostname exists, surfacing its current target via detail; diff reports drift
// when that target differs from the tunnel cname; apply upserts the proxied CNAME, stamped so it is
// attributable. The url output is derived from the hostname.
export const createCfRouteProvider = (api: CloudflareApi = cloudflareApi): Provider => ({
    read: async (inputs) => {
        const { hostname, zoneId, apiToken } = parseCfRouteInputs(inputs);
        const record = await api.findDnsRecord({ apiToken, zoneId, name: hostname });
        if (record === undefined) {
            return undefined;
        }
        return { outputs: { url: `https://${hostname}` }, detail: { content: record.content } };
    },
    diff: (inputs, observed) => {
        const { cname } = parseCfRouteInputs(inputs);
        const content = observed.detail?.["content"];
        if (content === cname) {
            return { action: "noop" };
        }
        return { action: "update", reason: `CNAME target "${String(content)}" differs from "${cname}"` };
    },
    apply: async (inputs, _observed, ctx) => {
        const { hostname, zoneId, apiToken, cname } = parseCfRouteInputs(inputs);
        const comment = formatStamp(ctx.id);
        const record = await api.findDnsRecord({ apiToken, zoneId, name: hostname });
        if (record === undefined) {
            await api.createDnsRecord({ apiToken, zoneId, name: hostname, content: cname, comment });
        } else {
            await api.updateDnsRecord({ apiToken, zoneId, recordId: record.id, name: hostname, content: cname, comment });
        }
        return { url: `https://${hostname}` };
    },
});
