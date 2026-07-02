import { randomBytes } from "node:crypto";
import { automationsContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import { Cron } from "croner";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import type { AutomationRecord } from "./automations-store.js";

// An invalid cron can only come from a hand-edited manifest (upsert rejects it) — surface "no next run"
// rather than failing the whole list. Event automations have no next run; they fire on their webhook.
const nextRunOf = (automation: AutomationRecord): number | undefined => {
    if (!automation.enabled || automation.trigger.kind !== "schedule") {
        return undefined;
    }
    try {
        return new Cron(automation.trigger.cron).nextRun()?.getTime();
    } catch {
        return undefined;
    }
};

// The automations manifest routes. `upsert` validates the cron with the scheduler's own parser, so what's
// accepted here is exactly what will fire.
export const createAutomationsRoutes = (services: Services) => {
    const i = implement(automationsContract).$context<OrpcContext>();
    return {
        list: i.list.handler(async () => ({
            // The records are this handler's own fresh read, so annotating them in place is safe.
            automations: (await services.automations.list()).map((automation) => {
                const nextRun = nextRunOf(automation);
                return nextRun !== undefined ? Object.assign(automation, { nextRun }) : automation;
            }),
        })),
        upsert: i.upsert.handler(async ({ input }) => {
            if (input.trigger.kind === "schedule") {
                try {
                    new Cron(input.trigger.cron).nextRun();
                } catch {
                    throw new ORPCError("BAD_REQUEST", { message: "invalid cron expression" });
                }
                await services.automations.upsert(input);
                return { ok: true } as const;
            }
            // Event: keep the round-tripped token (the enabled toggle re-posts the trigger) or mint the
            // webhook's auth token — /automations/{id}/fire compares against it.
            const trigger = input.trigger.token !== undefined ? input.trigger : { ...input.trigger, token: randomBytes(24).toString("base64url") };
            await services.automations.upsert({ ...input, trigger });
            return { ok: true } as const;
        }),
        remove: i.remove.handler(async ({ input }) => {
            if (!(await services.automations.remove(input.id))) {
                throw new ORPCError("NOT_FOUND", { message: "no automation with that id" });
            }
            return { ok: true } as const;
        }),
    };
};
