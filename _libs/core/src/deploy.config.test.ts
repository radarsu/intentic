import { expect, test } from "vitest";

import { graph } from "./deploy.config.js";
import { linearize } from "./index.js";
import { expectedGraph } from "./__fixtures__/deploy.graph.js";

test("declaration compiles to the expected desired-state graph", () => {
    expect(graph).toEqual(expectedGraph);
});

test("derived order is a valid topological linearization of the bootstrap", () => {
    const order = linearize(graph);
    const at = (id: string): number => order.indexOf(id);

    // Invariant: every node appears after all of its dependencies.
    for (const [id, node] of Object.entries(graph.resources)) {
        for (const dep of node.dependsOn) {
            expect(at(dep)).toBeLessThan(at(id));
        }
    }

    // It is a permutation of the resource ids (nothing dropped or duplicated).
    expect([...order].sort()).toEqual(Object.keys(graph.resources).sort());

    // Sanity on the headline phases: host -> forgejo -> app -> route.
    expect(at("host")).toBeLessThan(at("forgejo"));
    expect(at("forgejo")).toBeLessThan(at("my-app"));
    expect(at("my-app.staging")).toBeLessThan(at("route-staging"));
});

test("a ref edge serializes correctly", () => {
    expect(graph.resources["forgejo-runner"]?.inputs["token"]).toEqual({ $ref: "forgejo.runnerToken" });
    expect(graph.resources["forgejo-runner"]?.dependsOn).toContain("forgejo");
});

test("secrets serialize and are never literals", () => {
    expect(graph.resources["host"]?.inputs["sshKey"]).toEqual({ $secret: { source: "env", key: "HOST_SSH_KEY" } });
    expect(graph.resources["my-app.staging"]?.inputs["env"]).toEqual({ DATABASE_URL: { $secret: { source: "env", key: "STAGING_DATABASE_URL" } } });
});
