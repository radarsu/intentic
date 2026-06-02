import { expect, test } from "vitest";

import { parseDuration, waitReady } from "./readiness.js";

test("parseDuration parses second durations", () => {
    expect(parseDuration("120s")).toBe(120000);
    expect(parseDuration("90s")).toBe(90000);
    expect(parseDuration("60s")).toBe(60000);
});

test("parseDuration rejects unsupported formats", () => {
    expect(() => parseDuration("5m")).toThrow();
    expect(() => parseDuration("abc")).toThrow();
});

test("waitReady resolves once the probe succeeds", async () => {
    let calls = 0;
    await waitReady(
        "https://x/health",
        { timeout: "60s" },
        async () => {
            calls += 1;
            return calls >= 3;
        },
        1,
    );
    expect(calls).toBe(3);
});

test("waitReady throws when the probe never succeeds before the deadline", async () => {
    await expect(waitReady("https://x/health", { timeout: "0s" }, async () => false, 1)).rejects.toThrow(/timed out/);
});
