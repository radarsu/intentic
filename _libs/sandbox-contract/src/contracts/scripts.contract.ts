import { eventIterator, oc } from "@orpc/contract";
import { ScriptLineSchema } from "../events.js";
import { ScriptRunInputSchema, ScriptsListSchema } from "../schemas.js";

// The workspace's runnable scripts (.intentic/scripts.json, files-only authoring — no upsert/remove here).
// `list` joins the manifest with the daemon-recorded run history. `run` executes the script's command in the
// sandbox and streams stdout/stderr lines live, ending with an `exit` frame.
export const scriptsContract = {
    list: oc.route({ method: "GET", path: "/scripts" }).output(ScriptsListSchema),
    run: oc.route({ method: "POST", path: "/scripts/{id}/run" }).input(ScriptRunInputSchema).output(eventIterator(ScriptLineSchema)),
};
