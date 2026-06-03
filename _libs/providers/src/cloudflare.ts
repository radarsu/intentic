import type { Provider, ResolvedInputs } from "@puristic/deploy-engine";
import { z } from "zod";
import type { CloudflareApi } from "./cloudflare-api.js";
import { cloudflareApi } from "./cloudflare-api.js";
import { parseInputs } from "./inputs.js";

const cloudflareSchema = z.object({ accountId: z.string(), apiToken: z.string(), zone: z.string() });
const parse = (inputs: ResolvedInputs): z.infer<typeof cloudflareSchema> => parseInputs(cloudflareSchema, inputs, "cloudflare");

// The Cloudflare account+zone are OWNED — the provider RESOLVES the zone name to its zone id over the
// API; it never creates a zone. read returns the mapping if the zone exists, undefined (logged) if not,
// so a plan surfaces a misconfigured zone without aborting. diff is always noop (an owned, immutable
// name->id mapping has no managed drift). apply is reached only when read found nothing; it re-resolves
// and raises the hard error on a persistent not-found — an owned zone is not created here.
export const createCloudflareProvider = (api: CloudflareApi = cloudflareApi): Provider => ({
    read: async (inputs, ctx) => {
        const { accountId, apiToken, zone } = parse(inputs);
        const found = await api.getZone({ accountId, apiToken, zone });
        if (found === undefined) {
            ctx.log(`cloudflare "${ctx.id}": zone "${zone}" not found in account ${accountId}, treating as not-yet-resolved`);
            return undefined;
        }
        return { outputs: { zoneId: found.id } };
    },
    diff: () => ({ action: "noop" }),
    apply: async (inputs) => {
        const { accountId, apiToken, zone } = parse(inputs);
        const found = await api.getZone({ accountId, apiToken, zone });
        if (found === undefined) {
            throw new Error(`cloudflare zone "${zone}" does not exist in account ${accountId} (owned zones are not created)`);
        }
        return { zoneId: found.id };
    },
});
