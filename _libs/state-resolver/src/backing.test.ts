import { env } from "@intentic/graph";
import type { CloudflareIntent, HostIntent, IntentSet } from "@intentic/need-resolver";
import { needKey, resolveNeeds } from "@intentic/need-resolver";
import { expect, test } from "vitest";
import { forgejoCatalog } from "./catalog.js";
import type { Assignment } from "./emit.js";
import { emit } from "./emit.js";

const host: HostIntent = { id: "host", input: { address: "203.0.113.10", user: "deploy", sshKey: env("HOST_SSH_KEY") } };
const cloudflare: CloudflareIntent = { id: "cf", input: { apiToken: env("CLOUDFLARE_API_TOKEN") } };

const assign = (intent: IntentSet): Assignment => {
    const byNeed = new Map<string, string>();
    for (const need of resolveNeeds(intent)) {
        byNeed.set(needKey(need), forgejoCatalog.optionsFor(need.capability)[0]!.id);
    }
    return { byNeed };
};

// An app that uses a database + a cache, with both instances declared on the host.
const intentWithBindings: IntentSet = {
    hosts: [host],
    cloudflare,
    users: [],
    teams: [],
    services: [],
    backings: [
        { id: "db", capability: "database", on: "host" },
        { id: "cache", capability: "cache", on: "host" },
    ],
    apps: [
        {
            id: "app",
            on: "host",
            expose: "cf",
            use: [
                { capability: "database", target: "db" },
                { capability: "cache", target: "cache" },
            ],
            environments: { prod: { domain: "app.example.com", branch: "main" } },
        },
    ],
};

const nodesById = (intent: IntentSet) => new Map(emit(intent, assign(intent), "example.com").map((node) => [node.id, node]));

test("a backing instance is emitted as an internal-only node with no Cloudflare route", () => {
    const nodes = nodesById(intentWithBindings);
    const db = nodes.get("db");
    expect(db?.type).toBe("postgres");
    // Internal-only: the database/cache instances add NO cf-route. Only the platform's git/deploy routes and
    // the app's own route exist — none reference the backing instances.
    const routeIds = [...nodes.values()].filter((node) => node.type === "cf-route").map((node) => node.id);
    expect(routeIds).toEqual(["cf-git-example-com", "cf-deploy-example-com", "cf-app-example-com"]);
});

test("a per-app binding node is emitted per (app, instance) and depends on the instance", () => {
    const nodes = nodesById(intentWithBindings);
    const dbBinding = nodes.get("app-uses-db");
    const cacheBinding = nodes.get("app-uses-cache");
    expect(dbBinding?.type).toBe("postgres-database");
    expect(cacheBinding?.type).toBe("valkey-namespace");
    expect(dbBinding?.explicitDependsOn).toContain("db");
    expect(cacheBinding?.explicitDependsOn).toContain("cache");
    // The binding deploys onto the instance's host (SSH block present) and targets the instance by id.
    expect(dbBinding?.inputs["instance"]).toBe("db");
    expect(dbBinding?.inputs["address"]).toBe("203.0.113.10");
});

test("the deployment receives the binding connection env vars (DATABASE_URL, VALKEY_URL + REDIS_URL alias) and depends on each binding", () => {
    const nodes = nodesById(intentWithBindings);
    const deployment = nodes.get("app.prod");
    const env = deployment?.inputs["env"] as Record<string, unknown>;
    expect(env["DATABASE_URL"]).toEqual({ kind: "ref", resourceId: "app-uses-db", output: "url" });
    expect(env["VALKEY_URL"]).toEqual({ kind: "ref", resourceId: "app-uses-cache", output: "url" });
    expect(env["REDIS_URL"]).toEqual({ kind: "ref", resourceId: "app-uses-cache", output: "url" });
    expect(deployment?.explicitDependsOn).toEqual(expect.arrayContaining(["app-uses-db", "app-uses-cache"]));
});

test("an author env var overrides an injected binding var (binding spread before author env)", () => {
    const intent: IntentSet = {
        ...intentWithBindings,
        apps: [
            {
                ...intentWithBindings.apps[0]!,
                environments: { prod: { domain: "app.example.com", branch: "main", env: { DATABASE_URL: "postgres://custom" } } },
            },
        ],
    };
    const deployment = nodesById(intent).get("app.prod");
    expect((deployment?.inputs["env"] as Record<string, unknown>)["DATABASE_URL"]).toBe("postgres://custom");
});

test("using an undeclared backing is a descriptive error", () => {
    const intent: IntentSet = {
        ...intentWithBindings,
        backings: [],
        apps: [{ ...intentWithBindings.apps[0]!, use: [{ capability: "database", target: "ghost" }] }],
    };
    expect(() => emit(intent, assign(intent), "example.com")).toThrow(/uses unknown backing "ghost"/);
});

test("using a backing at the wrong capability is a descriptive error", () => {
    const intent: IntentSet = {
        ...intentWithBindings,
        apps: [{ ...intentWithBindings.apps[0]!, use: [{ capability: "cache", target: "db" }] }],
    };
    expect(() => emit(intent, assign(intent), "example.com")).toThrow(/uses "db" as cache but it is a database/);
});

test("a backing on an undeclared host is rejected (caught at need resolution)", () => {
    const intent: IntentSet = { ...intentWithBindings, backings: [{ id: "db", capability: "database", on: "ghost" }], apps: [] };
    expect(() => assign(intent)).toThrow(/targets undeclared host "ghost"/);
});
