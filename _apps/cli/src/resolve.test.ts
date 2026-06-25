import { fileURLToPath } from "node:url";
import { resolveState } from "@intentic/state-resolver";
import { describe, expect, it } from "vitest";
import { loadIntent } from "./resolve.js";
import { collectSecrets } from "./secrets.js";

const example = fileURLToPath(new URL("./__fixtures__/deploy.config.ts", import.meta.url));

describe("loadIntent", () => {
    it("loads an intent that resolves to a compiled graph", async () => {
        const intent = await loadIntent(example);
        expect(intent.apps.length).toBeGreaterThan(0);
        const graph = resolveState(intent);
        expect(graph.version).toBe(1);
        expect(Object.keys(graph.resources).length).toBeGreaterThan(0);
    });

    it("classifies secrets: externals are user-supplied, platform admin secrets are intentic-generated", async () => {
        const graph = resolveState(await loadIntent(example));
        // FORGEJO_ADMIN_PASSWORD / KOMODO_ADMIN_PASSWORD are injected by the resolver's platform layer and
        // marked generated; the externals stay env (intentic can't invent them).
        expect(collectSecrets(graph)).toEqual({
            env: ["CLOUDFLARE_API_TOKEN", "HOST_SSH_KEY", "PRODUCTION_DATABASE_URL", "STAGING_DATABASE_URL"],
            generated: ["FORGEJO_ADMIN_PASSWORD", "KOMODO_ADMIN_PASSWORD"],
        });
    });

    it("throws when the config does not export intent", async () => {
        const notAConfig = fileURLToPath(new URL("./artifact.ts", import.meta.url));
        await expect(loadIntent(notAConfig)).rejects.toThrow(/must export "intent"/);
    });
});
