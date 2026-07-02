import { capabilitiesContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { capabilityCtx, echoConfig } from "./capability.js";
import { browseMarketplace } from "./marketplace.js";
import { registry } from "./registry.js";

// The unified capability manifest routes. `add` streams its apply (mirroring /intentic): the handler yields
// progress frames, then the manifest entry is recorded, then a terminal `result`. A `requires` precondition
// (service/integration → devops) is checked before apply. `list` fans each handler's status() concurrently.
export const createCapabilitiesRoutes = (services: Services) => {
    const i = implement(capabilitiesContract).$context<OrpcContext>();
    const ctx = capabilityCtx(services);
    return {
        list: i.list.handler(async () => {
            const capabilities = await services.capabilities.list();
            const rows = await Promise.all(
                capabilities.map(async (capability) => ({
                    id: capability.id,
                    kind: capability.kind,
                    status: await registry[capability.kind].status(ctx, capability.id, capability.config),
                    config: echoConfig(capability),
                })),
            );
            return { capabilities: rows };
        }),
        add: i.add.handler(async function* ({ input }) {
            const handler = registry[input.kind];
            const active = await services.capabilities.list();
            for (const required of handler.requires ?? []) {
                if (!active.some((capability) => capability.kind === required)) {
                    throw new ORPCError("PRECONDITION_FAILED", { message: `activate ${required} first` });
                }
            }
            try {
                yield* handler.apply(ctx, input.id, input.config);
                await services.capabilities.upsert(input);
                yield { kind: "result", ok: true };
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                yield { kind: "error", message };
                throw new ORPCError("INTERNAL_SERVER_ERROR", { message });
            }
        }),
        remove: i.remove.handler(async ({ input }) => {
            const capability = await services.capabilities.get(input.id);
            if (capability === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "no capability with that id" });
            }
            const handler = registry[capability.kind];
            if (handler.remove === undefined) {
                throw new ORPCError("CONFLICT", { message: `the ${capability.kind} capability can't be removed` });
            }
            await handler.remove(ctx, capability.id, capability.config);
            await services.capabilities.remove(input.id);
            return { ok: true } as const;
        }),
        status: i.status.handler(async ({ input }) => {
            const capability = await services.capabilities.get(input.id);
            if (capability === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "no capability with that id" });
            }
            return registry[capability.kind].status(ctx, capability.id, capability.config);
        }),
        marketplace: i.marketplace.handler(async ({ input }) => browseMarketplace(ctx, input.url, input.token)),
    };
};
