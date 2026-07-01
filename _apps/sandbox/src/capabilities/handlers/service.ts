import type { InventoryEntry, ServiceConfig } from "@intentic/sandbox-contract";
import { hasManagedEntry, removeManagedEntry, upsertManagedEntry } from "../../inventory/managed-region.js";
import type { CapabilityHandler } from "../capability.js";

// A self-hosted service (e.g. SigNoz): declare it as i.want.service in deploy.config.ts, then provision it via
// the in-sandbox reconcile (resolve → apply), streaming progress. Requires DevOps (the intent repo). SigNoz's
// MCP is auto-wired by the resolver's service catalog, so the agent gets its tools with no extra work here.
export const serviceHandler: CapabilityHandler = {
    requires: ["devops"],
    apply: async function* (ctx, id, config) {
        const { service, domain, on, expose } = config as ServiceConfig;
        const entry: InventoryEntry = { kind: "service", service, name: id, on, expose, values: { domain } };
        await upsertManagedEntry(ctx.config, entry, `chore(intentic): add ${service} "${id}"`);
        yield { kind: "log", message: `Declared ${service} "${id}". Provisioning…` };
        yield* ctx.intentic({ args: ["resolve"], cwd: ctx.workspace.root });
        yield* ctx.intentic({ args: ["apply"], cwd: ctx.workspace.root });
        yield { kind: "log", message: `${service} "${id}" provisioned.` };
    },
    status: async (ctx, id) => ((await hasManagedEntry(ctx.config, id)) ? { state: "active" } : { state: "inactive" }),
    remove: async (ctx, id) => {
        await removeManagedEntry(ctx.config, id, `chore(intentic): remove "${id}"`);
    },
};
