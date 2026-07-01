import { join } from "node:path";
import { type InventoryEntry, inventoryContract } from "@intentic/sandbox-contract";
import { implement } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { readManagedRegion, scaffoldDeployConfig, writeManagedRegion } from "./deploy-config.js";

const INVENTORY_CONFIG = "deploy.config.ts";
const SELF_HOST_NAME = "self";
const COMMIT_AUTHOR = { name: "intentic", email: "agent@intentic.dev" } as const;

// The i.have.* / i.want.service entries in deploy.config.ts's managed region. add/remove rewrite the region and
// commit it (mirroring an agent edit). ensureSelfHost mirrors this sandbox's host into the inventory when
// connect.sh wired it as a deploy target, so `resolve` sees it.
export const createInventoryRoutes = (services: Services) => {
    const i = implement(inventoryContract).$context<OrpcContext>();
    const configPath = join(services.workspace.repos.intent, INVENTORY_CONFIG);
    const readConfig = async (): Promise<string> => (await services.files.read(configPath)) ?? scaffoldDeployConfig([]);
    const writeConfig = async (content: string, message: string): Promise<void> => {
        await services.files.write(configPath, content);
        await services.git.commitAll(services.workspace.repos.intent, message, COMMIT_AUTHOR);
    };
    const ensureSelfHost = async (content: string, entries: InventoryEntry[]): Promise<InventoryEntry[]> => {
        if (services.selfHost === undefined || entries.some((entry) => entry.name === SELF_HOST_NAME)) {
            return entries;
        }
        const next: InventoryEntry[] = [
            {
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
            },
            ...entries,
        ];
        await writeConfig(writeManagedRegion(content, next), "chore(intentic): register self host");
        return next;
    };
    return {
        list: i.list.handler(async () => {
            const content = await readConfig();
            return { entries: await ensureSelfHost(content, readManagedRegion(content)) };
        }),
        add: i.add.handler(async ({ input }) => {
            const content = await readConfig();
            // Upsert by name: a re-added capability replaces the old declaration.
            const next: InventoryEntry[] = [...readManagedRegion(content).filter((entry) => entry.name !== input.name), input];
            const label = input.kind === "service" ? input.service : input.provider;
            await writeConfig(writeManagedRegion(content, next), `chore(intentic): add ${label} "${input.name}"`);
            return { entries: next };
        }),
        remove: i.remove.handler(async ({ input }) => {
            const content = await readConfig();
            const entries = readManagedRegion(content);
            const next = entries.filter((entry) => entry.name !== input.name);
            if (next.length !== entries.length) {
                await writeConfig(writeManagedRegion(content, next), `chore(intentic): remove "${input.name}"`);
            }
            return { entries: next };
        }),
        selfHost: i.selfHost.handler(async () => {
            const content = await readConfig();
            await ensureSelfHost(content, readManagedRegion(content));
            return { ok: true } as const;
        }),
    };
};
