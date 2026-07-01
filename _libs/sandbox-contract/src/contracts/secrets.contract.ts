import { oc } from "@orpc/contract";
import { OkSchema, SecretKeysSchema, SecretSetSchema } from "../schemas.js";

// User-supplied env-var secrets, written to the sandbox's gitignored repositories/desired-state/.env (which
// `apply` reloads each run — no restart). `set` upserts one KEY=value; `list` returns the keys present (never
// the values). Both refuse until DevOps has scaffolded the desired-state repo.
export const secretsContract = {
    set: oc.route({ method: "POST", path: "/secrets" }).input(SecretSetSchema).output(OkSchema),
    list: oc.route({ method: "GET", path: "/secrets" }).output(SecretKeysSchema),
};
