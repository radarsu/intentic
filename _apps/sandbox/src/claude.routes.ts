import { claudeContract } from "@intentic/sandbox-contract";
import { implement } from "@orpc/server";
import { buildAuthorizeUrl, exchangeCode } from "./claude-credentials.js";
import type { Services } from "./composition.js";
import type { OrpcContext } from "./context.js";

// Claude subscription OAuth — the sandbox owns the credential, the platform never sees it. `start` hands the
// browser the authorize URL + PKCE material; `exchange` stores the tokens here; the agent route reads them.
export const createClaudeRoutes = (services: Services) => {
    const i = implement(claudeContract).$context<OrpcContext>();
    return {
        start: i.start.handler(() => buildAuthorizeUrl()),
        exchange: i.exchange.handler(async ({ input }) => {
            const account = await exchangeCode(input.code, input.verifier, input.state);
            await services.claudeStore.write(account);
            return { connected: true, ...(account.scope !== undefined ? { scope: account.scope } : {}) };
        }),
        account: i.account.handler(async () => {
            const account = await services.claudeStore.read();
            return { connected: account !== undefined, ...(account?.scope !== undefined ? { scope: account.scope } : {}) };
        }),
        disconnect: i.disconnect.handler(async () => {
            await services.claudeStore.clear();
            return { ok: true } as const;
        }),
    };
};
