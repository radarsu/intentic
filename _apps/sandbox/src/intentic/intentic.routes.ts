import { intenticContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";

// Run the in-sandbox intentic CLI over the workspace root, streaming its ndjson lines as they arrive. A
// non-zero exit makes runIntentic throw with the real stderr; surface that as a terminal `error` line the UI
// renders, THEN fail the RPC — otherwise oRPC masks the stderr behind a generic INTERNAL_SERVER_ERROR.
export const createIntenticRoutes = (services: Services) => {
    const i = implement(intenticContract).$context<OrpcContext>();
    return {
        run: i.run.handler(async function* ({ input }) {
            try {
                yield* services.intentic({ args: input.args, cwd: services.workspace.root });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                yield { kind: "error", message };
                throw new ORPCError("INTERNAL_SERVER_ERROR", { message });
            }
        }),
    };
};
