import { fileURLToPath } from "node:url";
import { choose, generateCandidates } from "@intentic/resolvers";
import { describe, expect, it } from "vitest";
import { loadIntent } from "./resolve.js";

const example = fileURLToPath(new URL("./__fixtures__/deploy.config.ts", import.meta.url));

describe("loadIntent", () => {
    it("loads an intent that generates a compiled graph", async () => {
        const intent = await loadIntent(example);
        expect(intent.apps.length).toBeGreaterThan(0);
        const { graph } = choose(generateCandidates(intent));
        expect(graph.version).toBe(1);
        expect(Object.keys(graph.resources).length).toBeGreaterThan(0);
    });

    it("throws when --prefer names an unknown candidate", async () => {
        const candidates = generateCandidates(await loadIntent(example));
        expect(() => choose(candidates, "no-such-key")).toThrow(/preferKey/);
    });

    it("throws when the config does not export intent", async () => {
        const notAConfig = fileURLToPath(new URL("./artifact.ts", import.meta.url));
        await expect(loadIntent(notAConfig)).rejects.toThrow(/must export "intent"/);
    });
});
