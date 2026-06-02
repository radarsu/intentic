import type { Provider, ResolvedInputs } from "@puristic/deploy-engine";
import type { CloudflareApi } from "./cloudflare-api.js";
import { cloudflareApi } from "./cloudflare-api.js";

interface CloudflareInputs {
    readonly accountId: string;
    readonly apiToken: string;
    readonly zone: string;
}

const parseCloudflareInputs = (inputs: ResolvedInputs): CloudflareInputs => {
    const accountId = inputs["accountId"];
    const apiToken = inputs["apiToken"];
    const zone = inputs["zone"];
    if (typeof accountId !== "string" || typeof apiToken !== "string" || typeof zone !== "string") {
        throw new Error(
            `cloudflare inputs malformed: accountId/apiToken/zone must be strings (got ${typeof accountId}/${typeof apiToken}/${typeof zone})`,
        );
    }
    return { accountId, apiToken, zone };
};

// The Cloudflare account+zone are OWNED — the provider RESOLVES the zone name to its zone id over the
// API; it never creates a zone. read returns the mapping if the zone exists, undefined (logged) if not,
// so a plan surfaces a misconfigured zone without aborting. diff is always noop (an owned, immutable
// name->id mapping has no managed drift). apply is reached only when read found nothing; it re-resolves
// and raises the hard error on a persistent not-found — an owned zone is not created here.
export const createCloudflareProvider = (api: CloudflareApi = cloudflareApi): Provider => ({
    read: async (inputs, ctx) => {
        const { accountId, apiToken, zone } = parseCloudflareInputs(inputs);
        const found = await api.getZone({ accountId, apiToken, zone });
        if (found === undefined) {
            ctx.log(`cloudflare "${ctx.id}": zone "${zone}" not found in account ${accountId}, treating as not-yet-resolved`);
            return undefined;
        }
        return { outputs: { zoneId: found.id } };
    },
    diff: () => ({ action: "noop" }),
    apply: async (inputs) => {
        const { accountId, apiToken, zone } = parseCloudflareInputs(inputs);
        const found = await api.getZone({ accountId, apiToken, zone });
        if (found === undefined) {
            throw new Error(`cloudflare zone "${zone}" does not exist in account ${accountId} (owned zones are not created)`);
        }
        return { zoneId: found.id };
    },
});
