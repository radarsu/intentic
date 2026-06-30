import { intenticContract } from "@intentic/sandbox-contract";
import { implement } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";

// Run the in-sandbox intentic CLI over the workspace root, streaming its ndjson lines as they arrive.
export const createIntenticRoutes = (services: Services) => {
    const i = implement(intenticContract).$context<OrpcContext>();
    return {
        run: i.run.handler(({ input }) => services.intentic({ args: input.args, cwd: services.workspace.root })),
    };
};
