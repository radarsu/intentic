import { describe, expect, test } from "vitest";
import { platformBaseFrom } from "./register.js";

describe("platformBaseFrom", () => {
    test("normalizes a wss url to its https origin (and strips the path)", () => {
        expect(platformBaseFrom("wss://platform.example/x")).toBe("https://platform.example");
    });

    test("normalizes a ws url (with port) to its http origin", () => {
        expect(platformBaseFrom("ws://localhost:6480/x")).toBe("http://localhost:6480");
    });

    test("reduces an already-http url to its origin", () => {
        expect(platformBaseFrom("https://platform.example/some/path")).toBe("https://platform.example");
    });

    test("returns undefined for an unparseable url", () => {
        expect(platformBaseFrom("not a url")).toBeUndefined();
    });
});
