import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFakeProviders, reconcile } from "@intentic/engine";
import { resolveState } from "@intentic/state-resolver";
import { describe, expect, it } from "vitest";
import { readArtifact, writeArtifact } from "./artifact.js";
import { loadIntent } from "./resolve.js";

const example = fileURLToPath(new URL("./__fixtures__/deploy.config.ts", import.meta.url));

// Every secret the example references: the host SSH key and Cloudflare API token plus the app secrets.
// The host address/user and Cloudflare account/zone are authored literals, so they are not here.
const fullEnv = {
    HOST_SSH_KEY: "k",
    CLOUDFLARE_API_TOKEN: "k",
    FORGEJO_ADMIN_PASSWORD: "k",
    KOMODO_ADMIN_PASSWORD: "k",
    KOMODO_WEBHOOK_SECRET: "k",
    STAGING_DATABASE_URL: "k",
    PRODUCTION_DATABASE_URL: "k",
};

describe("the local resolve → write → read → apply pipeline", () => {
    it("resolves to an artifact that reconciles to convergence with fake providers", async () => {
        const graph = resolveState(await loadIntent(example));
        const dir = await mkdtemp(join(tmpdir(), "intentic-cli-"));
        const path = join(dir, "desired-state.json");
        await writeArtifact(path, graph);

        const roundTripped = await readArtifact(path);
        const { providers } = createFakeProviders();
        const result = await reconcile(roundTripped, { providers, env: fullEnv, probe: async () => true, log: () => {} }, { maxIterations: 5 });

        expect(result.converged).toBe(true);
        expect(Object.keys(result.outcome.outputs).sort()).toEqual(Object.keys(roundTripped.resources).sort());
    });
});
