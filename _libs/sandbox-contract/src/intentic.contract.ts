import { eventIterator, oc } from "@orpc/contract";
import { IntenticLineSchema } from "./events.js";
import { IntenticRunSchema } from "./schemas.js";

// Run the in-sandbox intentic CLI (resolve/plan/apply/deployments/…) and stream its ndjson lines as they
// arrive, so the UI sees live progress. A non-zero exit surfaces as a thrown error once the stream ends.
export const intenticContract = {
    run: oc.route({ method: "POST", path: "/intentic" }).input(IntenticRunSchema).output(eventIterator(IntenticLineSchema)),
};
