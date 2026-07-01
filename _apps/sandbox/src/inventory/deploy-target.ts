import { existsSync } from "node:fs";
import type { InventoryEntry } from "@intentic/sandbox-contract";
import { writeManagedRegion } from "@intentic/scaffold";
import type { Services } from "../composition.js";
import type { ConfigStore } from "./config-store.js";

const SELF_HOST_NAME = "self";
const CLOUDFLARE_NAME = "cf";

// When this sandbox was wired as a deploy target (SELF_HOST=1), mirror it into deploy.config.ts's managed region
// so `resolve` sees it: the `self` host it deploys onto AND the `cf` cloudflare that exposes services/apps (the CF
// token is already in the container env). Add each only when absent; a single commit covers both. No-ops until
// DevOps has scaffolded the intent repo. Returns the resulting entries. Shared by the inventory routes and the
// DevOps capability handler.
export const ensureDeployTarget = async (
    services: Services,
    config: ConfigStore,
    content: string,
    entries: InventoryEntry[],
): Promise<InventoryEntry[]> => {
    if (services.selfHost === undefined || !existsSync(services.workspace.repos.intent)) {
        return entries;
    }
    const additions: InventoryEntry[] = [];
    if (!entries.some((entry) => entry.name === SELF_HOST_NAME)) {
        additions.push({
            kind: "backend",
            provider: "host",
            name: SELF_HOST_NAME,
            values: {
                address: services.selfHost.address,
                user: services.selfHost.user,
                port: services.selfHost.port,
                // Only the non-default transport is written to deploy.config.ts; "direct" is the resolver default.
                ...(services.selfHost.via !== "direct" ? { via: services.selfHost.via } : {}),
            },
        });
    }
    if (!entries.some((entry) => entry.name === CLOUDFLARE_NAME)) {
        additions.push({ kind: "backend", provider: "cloudflare", name: CLOUDFLARE_NAME, values: {} });
    }
    if (additions.length === 0) {
        return entries;
    }
    const next = [...additions, ...entries];
    await config.write(writeManagedRegion(content, next), "chore(intentic): register deploy target");
    return next;
};
