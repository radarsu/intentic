import { oc } from "@orpc/contract";
import { SessionIdParamSchema, SessionsListSchema, SessionTranscriptSchema } from "../schemas.js";

// Past conversations in this workspace (the SDK-native session store, keyed on the workspace dir). `list`
// returns summaries for the history menu; `get` restores one transcript for display.
export const sessionsContract = {
    list: oc.route({ method: "GET", path: "/sessions" }).output(SessionsListSchema),
    get: oc.route({ method: "GET", path: "/sessions/{id}" }).input(SessionIdParamSchema).output(SessionTranscriptSchema),
};
