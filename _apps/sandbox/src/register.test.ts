import { describe, expect, test } from "vitest";
import { platformBaseFrom } from "./register.js";

describe("platformBaseFrom", () => {
    test("derives the https origin from a wss gateway url", () => {
        expect(platformBaseFrom("wss://platform.example/runner/gateway")).toBe("https://platform.example");
    });

    test("derives the http origin (with port) from a ws gateway url", () => {
        expect(platformBaseFrom("ws://localhost:6480/runner/gateway")).toBe("http://localhost:6480");
    });

    test("reduces an already-http url to its origin", () => {
        expect(platformBaseFrom("https://platform.example/some/path")).toBe("https://platform.example");
    });

    test("returns undefined for an unparseable url", () => {
        expect(platformBaseFrom("not a url")).toBeUndefined();
    });
});
