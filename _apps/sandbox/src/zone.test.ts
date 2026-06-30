import { describe, expect, test } from "vitest";
import { zoneFromPublicUrl } from "./zone.js";

describe("zoneFromPublicUrl", () => {
    test("strips the sandbox-<hash> label off a public URL", () => {
        expect(zoneFromPublicUrl("https://sandbox-abc123.example.com")).toBe("example.com");
    });

    test("keeps a multi-label zone", () => {
        expect(zoneFromPublicUrl("https://sandbox-abc.example.co.uk")).toBe("example.co.uk");
    });

    test("ignores a trailing path", () => {
        expect(zoneFromPublicUrl("https://sandbox-abc.example.com/register")).toBe("example.com");
    });

    test("is undefined when there is no public URL", () => {
        expect(zoneFromPublicUrl(undefined)).toBeUndefined();
        expect(zoneFromPublicUrl("")).toBeUndefined();
    });

    test("is undefined when the host has no zone suffix", () => {
        expect(zoneFromPublicUrl("https://localhost")).toBeUndefined();
    });
});
