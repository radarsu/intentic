import { eventIterator, oc } from "@orpc/contract";
import { IntenticLineSchema } from "../events.js";
import { CapabilitiesListSchema, CapabilityIdParamSchema, CapabilitySchema, CapabilityStatusSchema, OkSchema } from "../schemas.js";

// The sandbox's unified capability manifest. `list` returns each active capability with its live status. `add`
// upserts a capability and STREAMS its apply (devops scaffolding / service provisioning emit ndjson progress;
// mcp/integration emit a terminal frame), mirroring the /intentic runner. `remove` tears it down (devops refuses
// — deleting the repos is data loss). `status` re-probes a single capability for a lazy UI refresh.
export const capabilitiesContract = {
    list: oc.route({ method: "GET", path: "/capabilities" }).output(CapabilitiesListSchema),
    add: oc.route({ method: "POST", path: "/capabilities" }).input(CapabilitySchema).output(eventIterator(IntenticLineSchema)),
    remove: oc.route({ method: "DELETE", path: "/capabilities/{id}" }).input(CapabilityIdParamSchema).output(OkSchema),
    status: oc.route({ method: "GET", path: "/capabilities/{id}/status" }).input(CapabilityIdParamSchema).output(CapabilityStatusSchema),
};
