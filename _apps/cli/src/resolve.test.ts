import { fileURLToPath } from "node:url";
import { choose } from "@intentic/resolvers";
import { describe, expect, it } from "vitest";
import { loadCandidates } from "./resolve.js";

const example = fileURLToPath(new URL("./__fixtures__/deploy.config.ts", import.meta.url));

describe("loadCandidates", () => {
    it("loads candidates from a deploy.config.ts and yields a compiled graph", async () => {
        const candidates = await loadCandidates(example);
        expect(candidates.length).toBeGreaterThan(0);
        const { graph } = choose(candidates);
        expect(graph.version).toBe(1);
        expect(Object.keys(graph.resources).length).toBeGreaterThan(0);
    });

    it("throws when --prefer names an unknown candidate", async () => {
        const candidates = await loadCandidates(example);
        expect(() => choose(candidates, "no-such-key")).toThrow(/preferKey/);
    });

    it("throws when the config does not export candidates", async () => {
        const notAConfig = fileURLToPath(new URL("./artifact.ts", import.meta.url));
        await expect(loadCandidates(notAConfig)).rejects.toThrow(/must export "candidates"/);
    });
});
