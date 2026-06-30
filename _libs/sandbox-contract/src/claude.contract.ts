import { oc } from "@orpc/contract";
import { AuthorizeChallengeSchema, ClaudeAccountSchema, ClaudeExchangeSchema, OkSchema } from "./schemas.js";

// Claude subscription OAuth — the sandbox owns the credential. `start` hands the browser the authorize URL +
// PKCE material; `exchange` stores the resulting tokens; `account`/`disconnect` report and clear them.
export const claudeContract = {
    start: oc.route({ method: "POST", path: "/claude/oauth/start" }).output(AuthorizeChallengeSchema),
    exchange: oc.route({ method: "POST", path: "/claude/oauth/exchange" }).input(ClaudeExchangeSchema).output(ClaudeAccountSchema),
    account: oc.route({ method: "GET", path: "/claude/account" }).output(ClaudeAccountSchema),
    disconnect: oc.route({ method: "POST", path: "/claude/account/disconnect" }).output(OkSchema),
};
