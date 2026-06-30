import { eventIterator, oc } from "@orpc/contract";
import { HeartbeatSchema } from "../events.js";
import { InfoSchema, PreviewSchema, SelfHostResponseSchema } from "../schemas.js";

// Sandbox status + identity, plus the long-lived liveness stream. `events` yields a heartbeat frame until the
// request aborts; the browser holds it open to detect the sandbox dying instantly.
export const systemContract = {
    preview: oc.route({ method: "GET", path: "/preview" }).output(PreviewSchema),
    selfHost: oc.route({ method: "GET", path: "/self-host" }).output(SelfHostResponseSchema),
    info: oc.route({ method: "GET", path: "/info" }).output(InfoSchema),
    events: oc.route({ method: "GET", path: "/events" }).output(eventIterator(HeartbeatSchema)),
};
