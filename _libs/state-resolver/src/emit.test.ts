import { env, makeRef } from "@intentic/graph";
import type { CloudflareIntent, HostIntent, IntentSet } from "@intentic/need-resolver";
import { needKey, resolveNeeds } from "@intentic/need-resolver";
import { expect, test } from "vitest";

import { defaultCatalog } from "./catalog.js";
import type { Assignment } from "./emit.js";
import { emit } from "./emit.js";

// The authored inventory every test intent wires its apps to (on: "host", expose: "cf").
const host: HostIntent = { id: "host", input: { address: "203.0.113.10", user: "deploy", sshKey: env("HOST_SSH_KEY") } };
const cloudflare: CloudflareIntent = { id: "cf", input: { accountId: "acc_123", apiToken: env("CLOUDFLARE_API_TOKEN"), zone: "example.com" } };

// The full single-combination assignment for an intent under the default catalog — the one combo emit
// supports today.
const assign = (intent: IntentSet): Assignment => {
    const byNeed = new Map<string, string>();
    for (const need of resolveNeeds(intent)) {
        const option = defaultCatalog.optionsFor(need.capability)[0];
        if (option === undefined) {
            throw new Error(`no option for ${need.capability}`);
        }
        byNeed.set(needKey(need), option.id);
    }
    return { byNeed };
};

test("emit derives the full support stack for a two-environment app", () => {
    const intent: IntentSet = {
        host,
        cloudflare,
        services: [],
        apps: [
            {
                id: "app",
                on: "host",
                expose: "cf",
                environments: {
                    staging: { domain: "staging.example.com", branch: "develop" },
                    production: { domain: "app.example.com", branch: "main" },
                },
            },
        ],
    };

    expect(emit(intent, assign(intent)).map((node) => node.id)).toEqual([
        "host",
        "cf",
        "host-git",
        "host-git-runner",
        "host-deploy",
        "cf-git-example-com",
        "cf-komodo-example-com",
        "app-repo",
        "app",
        "app.staging",
        "cf-staging-example-com",
        "app.staging-deploy-hook",
        "app.production",
        "cf-app-example-com",
        "app.production-deploy-hook",
        "host-tunnel",
    ]);
});

test("apps share one derived platform", () => {
    const intent: IntentSet = {
        host,
        cloudflare,
        services: [],
        apps: [
            { id: "one", on: "host", expose: "cf", environments: { prod: { domain: "one.example.com", branch: "main" } } },
            { id: "two", on: "host", expose: "cf", environments: { prod: { domain: "two.example.com", branch: "main" } } },
        ],
    };

    const types = emit(intent, assign(intent)).map((node) => node.type);
    expect(types.filter((type) => type === "forgejo")).toHaveLength(1);
    expect(types.filter((type) => type === "komodo")).toHaveLength(1);
    // One tunnel for the shared host, across all apps.
    expect(types.filter((type) => type === "tunnel")).toHaveLength(1);
});

test("an unsupported option assignment throws", () => {
    const intent: IntentSet = {
        host,
        cloudflare,
        services: [],
        apps: [{ id: "app", on: "host", expose: "cf", environments: { prod: { domain: "app.example.com", branch: "main" } } }],
    };
    const byNeed = new Map(assign(intent).byNeed);
    byNeed.set("source-control:host", "gitlab");
    expect(() => emit(intent, { byNeed })).toThrow('unsupported option "gitlab"');
});

test("notify derives a Forgejo webhook (CI) and a Komodo alerter (CD), wired to the app's stack", () => {
    const intent: IntentSet = {
        host,
        cloudflare,
        services: [],
        apps: [
            {
                id: "app",
                on: "host",
                expose: "cf",
                notify: { discord: env("DISCORD_WEBHOOK_URL") },
                environments: { prod: { domain: "app.example.com", branch: "main" } },
            },
        ],
    };

    const nodes = emit(intent, assign(intent));
    const forgejoNotify = nodes.find((node) => node.id === "app-repo-notify");
    const komodoNotify = nodes.find((node) => node.id === "app-notify");

    expect(forgejoNotify?.type).toBe("forgejo-notify");
    expect(forgejoNotify?.explicitDependsOn).toEqual(["host-git", "cf-git-example-com", "app-repo"]);
    expect(komodoNotify?.type).toBe("komodo-notify");
    expect(komodoNotify?.explicitDependsOn).toEqual(["host-deploy", "cf-komodo-example-com", "app", "app.prod"]);

    // The webhook secret passes through unresolved — the engine resolves it per apply.
    expect(forgejoNotify?.inputs["webhook"]).toEqual(env("DISCORD_WEBHOOK_URL"));
    expect(komodoNotify?.inputs["webhook"]).toEqual(env("DISCORD_WEBHOOK_URL"));
});

test("an app without notify derives no notification sinks", () => {
    const intent: IntentSet = {
        host,
        cloudflare,
        services: [],
        apps: [{ id: "app", on: "host", expose: "cf", environments: { prod: { domain: "app.example.com", branch: "main" } } }],
    };

    const types = emit(intent, assign(intent)).map((node) => node.type);
    expect(types.filter((type) => type === "forgejo-notify")).toHaveLength(0);
    expect(types.filter((type) => type === "komodo-notify")).toHaveLength(0);
});

test("notification sinks are derived per app, while the platform stays shared per host", () => {
    const intent: IntentSet = {
        host,
        cloudflare,
        services: [],
        apps: [
            {
                id: "one",
                on: "host",
                expose: "cf",
                notify: { discord: env("WEBHOOK") },
                environments: { prod: { domain: "one.example.com", branch: "main" } },
            },
            {
                id: "two",
                on: "host",
                expose: "cf",
                notify: { discord: env("WEBHOOK") },
                environments: { prod: { domain: "two.example.com", branch: "main" } },
            },
        ],
    };

    const types = emit(intent, assign(intent)).map((node) => node.type);
    expect(types.filter((type) => type === "forgejo-notify")).toHaveLength(2);
    expect(types.filter((type) => type === "komodo-notify")).toHaveLength(2);
    expect(types.filter((type) => type === "forgejo")).toHaveLength(1);
    expect(types.filter((type) => type === "komodo")).toHaveLength(1);
});

test("a services-only intent emits the service + its route + tunnel, but no app platform", () => {
    const intent: IntentSet = {
        host,
        cloudflare,
        services: [{ id: "obs", kind: "signoz", on: "host", expose: "cf", domain: "signoz.example.com" }],
        apps: [],
    };

    const nodes = emit(intent, assign(intent));
    expect(nodes.map((node) => node.id)).toEqual(["host", "cf", "obs", "cf-signoz-example-com", "host-tunnel"]);
    const signoz = nodes.find((node) => node.id === "obs");
    expect(signoz?.type).toBe("signoz");
    expect(signoz?.inputs["domain"]).toBe("signoz.example.com");
    // The build platform exists only to ship apps from source — a services-only intent skips it.
    expect(nodes.some((node) => node.type === "forgejo")).toBe(false);
    expect(nodes.some((node) => node.type === "komodo")).toBe(false);
    // The service's dashboard port is aggregated onto the host tunnel's ingress.
    expect(nodes.find((node) => node.id === "host-tunnel")?.inputs["ingress"]).toEqual([{ hostname: "signoz.example.com", port: 8080 }]);
});

test("an app's observe injects the service's OTLP endpoint into each deployment and depends on the service", () => {
    const intent: IntentSet = {
        host,
        cloudflare,
        services: [{ id: "obs", kind: "signoz", on: "host", expose: "cf", domain: "signoz.example.com" }],
        apps: [
            {
                id: "app",
                on: "host",
                expose: "cf",
                observe: "obs",
                environments: { prod: { domain: "app.example.com", branch: "main", env: { DATABASE_URL: env("DB") } } },
            },
        ],
    };

    const deployment = emit(intent, assign(intent)).find((node) => node.id === "app.prod");
    // OTLP wiring is spread before the author's env, so an explicit DATABASE_URL survives alongside it.
    expect(deployment?.inputs["env"]).toEqual({
        OTEL_EXPORTER_OTLP_ENDPOINT: makeRef("obs", "otlpEndpoint"),
        OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
        DATABASE_URL: env("DB"),
    });
    expect(deployment?.explicitDependsOn).toContain("obs");
});

test("an app without observe carries no OTLP env and no service dependency", () => {
    const intent: IntentSet = {
        host,
        cloudflare,
        services: [],
        apps: [{ id: "app", on: "host", expose: "cf", environments: { prod: { domain: "app.example.com", branch: "main" } } }],
    };

    const deployment = emit(intent, assign(intent)).find((node) => node.id === "app.prod");
    expect(deployment?.inputs["env"]).toBeUndefined();
    expect(deployment?.explicitDependsOn).toEqual(["app", "cf-komodo-example-com"]);
});

test("observing an undeclared service throws", () => {
    const intent: IntentSet = {
        host,
        cloudflare,
        services: [],
        apps: [{ id: "app", on: "host", expose: "cf", observe: "ghost", environments: { prod: { domain: "app.example.com", branch: "main" } } }],
    };

    expect(() => emit(intent, assign(intent))).toThrow('app "app" observes unknown service "ghost"');
});
