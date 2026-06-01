import { expect, test } from "vitest";

import { hello } from "./index.js";

test("hello greets by name", () => {
    expect(hello("deploy")).toBe("Hello, deploy!");
});
