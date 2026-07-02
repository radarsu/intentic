import { describe, expect, it } from "vitest";
import { decide, resolveConflict } from "./engine.js";

// The decision core is the whole correctness argument for two-way sync — exercise every branch, including the
// undefined (absent / never-synced) edges and the echo case (both sides identical → noop).
describe("decide", () => {
    it("no-ops when both sides already agree (this is also how an echo of our own write is absorbed)", () => {
        expect(decide("a", "a", "old")).toBe("noop");
        expect(decide(undefined, undefined, "old")).toBe("noop"); // both deleted
        expect(decide("a", "a", undefined)).toBe("noop"); // identical first-run files
    });

    it("takes the remote when only the remote moved", () => {
        expect(decide("base", "next", "base")).toBe("pullToLocal");
        expect(decide("base", undefined, "base")).toBe("deleteLocal");
        expect(decide(undefined, "next", undefined)).toBe("pullToLocal"); // fresh remote-only file
    });

    it("takes the local when only the local moved", () => {
        expect(decide("next", "base", "base")).toBe("pushToRemote");
        expect(decide(undefined, "base", "base")).toBe("deleteRemote");
        expect(decide("next", undefined, undefined)).toBe("pushToRemote"); // fresh local-only file
    });

    it("flags a conflict when both sides moved apart", () => {
        expect(decide("mine", "theirs", "base")).toBe("conflict");
        expect(decide("mine", "theirs", undefined)).toBe("conflict"); // both created different files at once
    });
});

describe("resolveConflict", () => {
    it("is last-writer-wins with remote breaking an exact tie", () => {
        expect(resolveConflict(100, 200)).toBe("remote");
        expect(resolveConflict(200, 100)).toBe("local");
        expect(resolveConflict(150, 150)).toBe("remote");
    });
});
