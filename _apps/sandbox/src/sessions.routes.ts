import { sessionsContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "./composition.js";
import type { OrpcContext } from "./context.js";

// Past conversations in this workspace (SDK-native session store, keyed on the workspace dir). A read that
// throws (no such session) becomes NOT_FOUND — the route's documented behavior, not a swallowed error.
export const createSessionsRoutes = (services: Services) => {
    const i = implement(sessionsContract).$context<OrpcContext>();
    return {
        list: i.list.handler(async () => ({ sessions: await services.sessions.list(services.workspace.root) })),
        get: i.get.handler(async ({ input }) => {
            try {
                return { messages: await services.sessions.read(services.workspace.root, input.id) };
            } catch {
                throw new ORPCError("NOT_FOUND", { message: "session not found" });
            }
        }),
    };
};
