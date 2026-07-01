import { type InventoryEntry, inventoryContract } from "@intentic/sandbox-contract";
import { readManagedRegion, writeManagedRegion } from "@intentic/scaffold";
import { implement } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { createConfigStore } from "./config-store.js";

const SELF_HOST_NAME = "self";
const CLOUDFLARE_NAME = "cf";

// The i.have.* / i.want.service entries in deploy.config.ts's managed region. add/remove rewrite the region and
// commit it (mirroring an agent edit). ensureDeployTarget mirrors this sandbox's deploy target into the inventory
// when connect.sh wired it (SELF_HOST=1), so `resolve` sees it.
export const createInventoryRoutes = (services: Services) => {
    const i = implement(inventoryContract).$context<OrpcContext>();
    const config = createConfigStore(services);

    // When this sandbox was wired as a deploy target (SELF_HOST=1), mirror it into the inventory so `resolve`
    // sees it: the `self` host it deploys onto AND the `cf` cloudflare that exposes services/apps (the CF token
    // is already in the container env). Add each only when absent; a single commit covers both.
    const ensureDeployTarget = async (content: string, entries: InventoryEntry[]): Promise<InventoryEntry[]> => {
        if (services.selfHost === undefined) {
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

    return {
        list: i.list.handler(async () => {
            const content = await config.read();
            return { entries: await ensureDeployTarget(content, readManagedRegion(content)) };
        }),
        add: i.add.handler(async ({ input }) => {
            const content = await config.read();
            // Upsert by name: a re-added capability replaces the old declaration.
            const next: InventoryEntry[] = [...readManagedRegion(content).filter((entry) => entry.name !== input.name), input];
            const label = input.kind === "service" ? input.service : input.provider;
            await config.write(writeManagedRegion(content, next), `chore(intentic): add ${label} "${input.name}"`);
            return { entries: next };
        }),
        remove: i.remove.handler(async ({ input }) => {
            const content = await config.read();
            const entries = readManagedRegion(content);
            const next = entries.filter((entry) => entry.name !== input.name);
            if (next.length !== entries.length) {
                await config.write(writeManagedRegion(content, next), `chore(intentic): remove "${input.name}"`);
            }
            return { entries: next };
        }),
        selfHost: i.selfHost.handler(async () => {
            const content = await config.read();
            await ensureDeployTarget(content, readManagedRegion(content));
            return { ok: true } as const;
        }),
    };
};
