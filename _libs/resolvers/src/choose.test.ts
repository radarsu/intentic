import { expect, test } from "vitest";

import type { Candidate } from "./candidate.js";
import { choose } from "./choose.js";

const candidate = (key: string): Candidate => ({ key, chosenOptions: {}, graph: { version: 1, resources: {} } });

test("choosing from no candidates throws", () => {
    expect(() => choose([])).toThrow("no candidate desired-state artifacts");
});

test("without a preferKey the first candidate wins", () => {
    expect(choose([candidate("a"), candidate("b")]).key).toBe("a");
});

test("a preferKey selects the matching candidate", () => {
    expect(choose([candidate("a"), candidate("b")], "b").key).toBe("b");
});

test("a preferKey with no match throws", () => {
    expect(() => choose([candidate("a")], "z")).toThrow('no candidate matches preferKey "z"');
});
