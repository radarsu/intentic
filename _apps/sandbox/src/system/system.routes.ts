import { type Heartbeat, systemContract } from "@intentic/sandbox-contract";
import { implement } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";

// Long-lived liveness stream: the browser holds it open so it detects the sandbox dying instantly (the tunnel
// drops the proxied response when the origin goes away). Heartbeat frames also trip a client watchdog.
async function* heartbeat(signal: AbortSignal | undefined): AsyncGenerator<Heartbeat> {
    const abort = signal ?? new AbortController().signal;
    while (!abort.aborted) {
        yield { kind: "heartbeat" };
        await new Promise((resolve) => {
            setTimeout(resolve, 2000);
        });
    }
}

export const createSystemRoutes = (services: Services) => {
    const i = implement(systemContract).$context<OrpcContext>();
    return {
        preview: i.preview.handler(() => services.devServer.status()),
        devLogs: i.devLogs.handler(() => services.devServer.logs()),
        info: i.info.handler(() => services.info ?? {}),
        events: i.events.handler(({ signal }) => heartbeat(signal)),
    };
};
