import { expect, test } from "vitest";

import { IMAGES } from "./images.js";

// Every pin must be fully immutable: a registry/repo, an explicit tag (never `latest`), AND a sha256 digest.
// This guards the strict-locking invariant — a loosely-tagged or digest-less entry fails here, so an
// accidental `:latest` or major-only pin can never land.
const STRICT = /^[a-z0-9.\-/:]+:[A-Za-z0-9][\w.-]*@sha256:[a-f0-9]{64}$/;

// First-party intentic images are digest-pinned like the rest once published under their nested GHCR name.
// `sandbox` is still tag-only (its digest is seeded after its first publish), so it alone is exempt from the
// strict-digest check (but must still never float on :latest).
const FIRST_PARTY = new Set(["sandbox"]);

test("every image is pinned to a full tag + sha256 digest", () => {
    for (const [name, ref] of Object.entries(IMAGES)) {
        if (!FIRST_PARTY.has(name)) {
            expect(ref, `${name} must match repo:tag@sha256:<digest>`).toMatch(STRICT);
        }
        expect(ref, `${name} must not use a floating :latest tag`).not.toContain(":latest");
    }
});
