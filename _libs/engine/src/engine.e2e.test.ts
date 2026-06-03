import { defineStack } from "@puristic/deploy-core";
import { env, linearize } from "@puristic/deploy-protocol";
import { expect, test } from "vitest";

import { apply } from "./apply.js";
import { plan } from "./plan.js";
import { createFakeProviders } from "./providers/fake.js";

// The full secret set the example declaration references.
const fullEnv = {
    HOST_SSH_KEY: "k",
    CLOUDFLARE_API_TOKEN: "k",
    FORGEJO_ADMIN_PASSWORD: "k",
    KOMODO_ADMIN_PASSWORD: "k",
    KOMODO_WEBHOOK_SECRET: "k",
    STAGING_DATABASE_URL: "k",
    PRODUCTION_DATABASE_URL: "k",
};

// Source the real graph from the authoring stack (build -> resolve -> compile), not a hand copy.
const buildGraph = () =>
    defineStack((i) => {
        const host = i.have.host("host", { address: "203.0.113.10", user: "deploy", sshKey: env("HOST_SSH_KEY") });
        const cf = i.have.cloudflare("cf", { accountId: "acc_123", apiToken: env("CLOUDFLARE_API_TOKEN"), zone: "example.com" });
        i.want.app("my-app", {
            on: host,
            expose: cf,
            environments: {
                staging: { domain: "staging.example.com", branch: "develop", env: { DATABASE_URL: env("STAGING_DATABASE_URL") } },
                production: { domain: "app.example.com", branch: "main", env: { DATABASE_URL: env("PRODUCTION_DATABASE_URL") } },
            },
        });
    });

const trueProbe = async () => true;
const silent = () => {};

test("apply creates every resource in dependency order, then is idempotent", async () => {
    const graph = buildGraph();
    const { providers } = createFakeProviders();

    const first = await apply(graph, { providers, env: fullEnv, probe: trueProbe, log: silent });
    expect(first.steps).toHaveLength(16);
    expect(first.steps.every((step) => step.action === "create")).toBe(true);
    expect(first.steps.map((step) => step.id)).toEqual(linearize(graph));
    expect(Object.keys(first.outputs).sort()).toEqual(Object.keys(graph.resources).sort());
    expect(first.orphans).toEqual([]);

    // Same providers (same world) => everything is found => all noop.
    const second = await apply(graph, { providers, env: fullEnv, probe: trueProbe, log: silent });
    expect(second.steps.every((step) => step.action === "noop")).toBe(true);
});

test("plan reports all create on an empty world and all noop after apply", async () => {
    const graph = buildGraph();

    const empty = createFakeProviders();
    const planned = await plan(graph, { providers: empty.providers, env: fullEnv, probe: trueProbe, log: silent });
    expect(planned.steps.every((step) => step.action === "create")).toBe(true);

    const live = createFakeProviders();
    await apply(graph, { providers: live.providers, env: fullEnv, probe: trueProbe, log: silent });
    const replanned = await plan(graph, { providers: live.providers, env: fullEnv, probe: trueProbe, log: silent });
    expect(replanned.steps.every((step) => step.action === "noop")).toBe(true);
});

test("a missing secret throws", async () => {
    const graph = buildGraph();
    const { providers } = createFakeProviders();
    const withoutHostKey = { ...fullEnv, HOST_SSH_KEY: undefined };
    await expect(apply(graph, { providers, env: withoutHostKey, probe: trueProbe, log: silent })).rejects.toThrow(
        'missing secret env var "HOST_SSH_KEY"',
    );
});

test("a node whose type has no provider throws", async () => {
    const graph = buildGraph();
    const { providers } = createFakeProviders();
    const withoutKomodo = { ...providers, komodo: undefined };
    await expect(apply(graph, { providers: withoutKomodo, env: fullEnv, probe: trueProbe, log: silent })).rejects.toThrow(
        'no provider registered for type "komodo"',
    );
});

test("an orphan (stamped, not in the graph) is reported and left intact", async () => {
    const graph = buildGraph();
    const { providers, world } = createFakeProviders();
    world.set("ghost-host", { type: "host", inputs: {} });

    const result = await apply(graph, { providers, env: fullEnv, probe: trueProbe, log: silent });
    expect(result.orphans).toContainEqual({ id: "ghost-host", type: "host" });
    expect(world.has("ghost-host")).toBe(true);
});

test("a referenced output that a provider failed to produce throws", async () => {
    const graph = buildGraph();
    const { providers } = createFakeProviders();
    const forgejo = providers["forgejo"];
    if (forgejo === undefined) {
        throw new Error("expected a forgejo provider");
    }
    const broken = { ...providers, forgejo: { ...forgejo, apply: async () => ({}) } };
    // host-git's own readyWhen gate now references its internal url, so that is the first ref to fail.
    await expect(apply(graph, { providers: broken, env: fullEnv, probe: trueProbe, log: silent })).rejects.toThrow(/host-git\.internalUrl/);
});
