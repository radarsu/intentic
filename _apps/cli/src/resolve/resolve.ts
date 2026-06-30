import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { IntentSet } from "@intentic/need-resolver";
import { cloudflareApi } from "@intentic/providers";
import { collectDomains, selectZone } from "@intentic/state-resolver";
import { loadEnvFile } from "../lib/artifact.js";

// Load the intent a deploy.config.ts exports by importing it IN PLACE — so its `@intentic/sdk` and
// `@intentic/graph` imports resolve from the project the config lives in (Node strips the TS types).
// The resolvers turn this intent into the desired state at resolve time.
export const loadIntent = async (configPath: string): Promise<IntentSet> => {
    const loaded = (await import(pathToFileURL(resolve(configPath)).href)) as { intent?: IntentSet };
    if (loaded.intent === undefined) {
        throw new Error(`${configPath} must export "intent" (from defineIntent)`);
    }
    return loaded.intent;
};

// Discover the Cloudflare zone the authored domains live under, from the API token alone: load .env so the
// token is available, list the zones the token can see, and match the declared domains against them. Returns
// undefined when there is nothing to expose (no apps/services) — the resolver then needs no zone. This is the
// one place resolve reaches the network; everything downstream (plan/apply) reads the baked artifact.
export const discoverZone = async (intent: IntentSet, dir: string): Promise<string | undefined> => {
    const cloudflare = intent.cloudflare;
    if (cloudflare === undefined || (intent.apps.length === 0 && intent.services.length === 0)) {
        return undefined;
    }
    loadEnvFile(dir);
    const token = cloudflare.input.apiToken;
    if (token.source !== "env") {
        throw new Error(`cloudflare apiToken must be an env() secret, but it is "${token.source}"`);
    }
    const apiToken = process.env[token.key];
    if (apiToken === undefined || apiToken === "") {
        throw new Error(`set ${token.key} (your Cloudflare API token) before resolve — it is needed to discover your zone and account`);
    }
    const zones = await cloudflareApi.listZones({ apiToken });
    return selectZone(
        zones.map((zone) => zone.name),
        collectDomains(intent),
    );
};
