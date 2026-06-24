import type { Candidate } from "./candidate.js";

// Pick one desired-state artifact. Deterministic for now: an explicit preferKey wins, otherwise
// the first candidate. (The LLM-suggestion seam — ranking candidates before this picks — lands here in a
// later increment.)
export const choose = (candidates: readonly Candidate[], preferKey?: string): Candidate => {
    if (candidates.length === 0) {
        throw new Error("no candidate desired-state artifacts to choose from");
    }
    if (preferKey === undefined) {
        return candidates[0] as Candidate;
    }
    const preferred = candidates.find((candidate) => candidate.key === preferKey);
    if (preferred === undefined) {
        throw new Error(`no candidate matches preferKey "${preferKey}"`);
    }
    return preferred;
};
