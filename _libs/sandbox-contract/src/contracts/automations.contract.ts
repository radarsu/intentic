import { oc } from "@orpc/contract";
import { AutomationIdParamSchema, AutomationSchema, AutomationsListSchema, OkSchema } from "../schemas.js";

// The sandbox's automations manifest (scheduled agent wake-ups). `list` returns each automation with its recent
// runs + next fire time. `upsert` adds or edits by id (nothing to provision — the scheduler picks it up on its
// next poll), so the enabled toggle is a plain re-post. `remove` deletes.
export const automationsContract = {
    list: oc.route({ method: "GET", path: "/automations" }).output(AutomationsListSchema),
    upsert: oc.route({ method: "POST", path: "/automations" }).input(AutomationSchema).output(OkSchema),
    remove: oc.route({ method: "DELETE", path: "/automations/{id}" }).input(AutomationIdParamSchema).output(OkSchema),
};
