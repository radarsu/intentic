import { expect, test } from "vitest";

import type { IntentSet } from "./intent.js";
import { deriveNeeds } from "./needs.js";

test("an app derives the four host capabilities plus a domain", () => {
    const intent: IntentSet = {
        apps: [{ id: "app", environments: { prod: { domain: "app.example.com", branch: "main" } } }],
    };

    expect(deriveNeeds(intent)).toEqual([
        { capability: "source-control", scope: "host" },
        { capability: "docker-registry", scope: "host" },
        { capability: "infra-control", scope: "host" },
        { capability: "deployment-target", scope: "host" },
        { capability: "domain", scope: "cf" },
    ]);
});

test("multiple apps collapse to one set of needs on the shared implicit host and cloud", () => {
    const intent: IntentSet = {
        apps: [
            { id: "one", environments: { prod: { domain: "one.example.com", branch: "main" } } },
            { id: "two", environments: { prod: { domain: "two.example.com", branch: "main" } } },
        ],
    };

    expect(deriveNeeds(intent)).toHaveLength(5);
});

test("no apps derive no needs", () => {
    expect(deriveNeeds({ apps: [] })).toEqual([]);
});
