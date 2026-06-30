import { oc } from "@orpc/contract";
import { AddInventoryInputSchema, InventoryListSchema, InventoryNameParamSchema, OkSchema } from "./schemas.js";

// The i.have.* / i.want.service entries in deploy.config.ts's managed region. add/remove rewrite the region
// and commit it (mirroring an agent edit); selfHost idempotently registers this sandbox's host as a deploy
// target. add/remove return the full updated list so the UI re-renders from one response.
export const inventoryContract = {
    list: oc.route({ method: "GET", path: "/inventory" }).output(InventoryListSchema),
    add: oc.route({ method: "POST", path: "/inventory" }).input(AddInventoryInputSchema).output(InventoryListSchema),
    remove: oc.route({ method: "DELETE", path: "/inventory/{name}" }).input(InventoryNameParamSchema).output(InventoryListSchema),
    selfHost: oc.route({ method: "POST", path: "/inventory/self-host" }).output(OkSchema),
};
