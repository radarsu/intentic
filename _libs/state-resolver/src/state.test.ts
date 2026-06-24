import { env } from "@intentic/graph";
import type { IntentSet } from "@intentic/need-resolver";
import { expect, test } from "vitest";
import type { Catalog } from "./catalog.js";
import { defaultCatalog } from "./catalog.js";
import { resolveState } from "./state.js";

const intent: IntentSet = {
    host: { id: "host", input: { address: "203.0.113.10", user: "deploy", sshKey: env("HOST_SSH_KEY") } },
    cloudflare: { id: "cf", input: { accountId: "acc_123", apiToken: env("CLOUDFLARE_API_TOKEN"), zone: "example.com" } },
    apps: [{ id: "app", on: "host", expose: "cf", environments: { prod: { domain: "app.example.com", branch: "main" } } }],
};

test("the default catalog resolves intent to one desired-state graph built from the fixed stack", () => {
    const graph = resolveState(intent);
    expect(graph.version).toBe(1);
    // Forgejo fills both source-control and docker-registry, so the shared option appears once.
    expect(Object.keys(graph.resources)).toContain("host-git");
    expect(Object.keys(graph.resources)).toContain("host-deploy");
});

test("no apps resolve to an empty desired state", () => {
    expect(resolveState({ apps: [] })).toEqual({ version: 1, resources: {} });
});

test("a need with no option throws", () => {
    const empty: Catalog = { optionsFor: (capability) => (capability === "infra-control" ? [] : defaultCatalog.optionsFor(capability)) };
    expect(() => resolveState(intent, empty)).toThrow('no option satisfies "infra-control"');
});

test("an ambiguous capability throws — the state resolver makes no choice", () => {
    const ambiguous: Catalog = {
        optionsFor: (capability) =>
            capability === "infra-control" ? [...defaultCatalog.optionsFor(capability), { id: "nomad", provides: ["infra-control"] }] : defaultCatalog.optionsFor(capability),
    };
    expect(() => resolveState(intent, ambiguous)).toThrow(/ambiguous: "infra-control"/);
});
