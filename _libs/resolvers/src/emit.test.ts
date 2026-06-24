import { env } from "@intentic/graph";
import { expect, test } from "vitest";

import { defaultCatalog } from "./catalog.js";
import type { Assignment } from "./emit.js";
import { emit } from "./emit.js";
import type { IntentSet } from "./intent.js";
import { deriveNeeds, needKey } from "./needs.js";

const cloud = { id: "cf", input: { accountId: "a", apiToken: env("T"), zone: "example.com" } };
const host = { id: "host", input: { address: "1.2.3.4", user: "deploy", sshKey: env("K") } };

// The full single-combination assignment for an intent under the default catalog — the one combo emit
// supports today.
const assign = (intent: IntentSet): Assignment => {
    const byNeed = new Map<string, string>();
    for (const need of deriveNeeds(intent)) {
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
        hosts: [host],
        clouds: [cloud],
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

test("apps on the same host share one derived platform", () => {
    const intent: IntentSet = {
        hosts: [host],
        clouds: [cloud],
        apps: [
            { id: "one", on: "host", expose: "cf", environments: { prod: { domain: "one.example.com", branch: "main" } } },
            { id: "two", on: "host", expose: "cf", environments: { prod: { domain: "two.example.com", branch: "main" } } },
        ],
    };

    const types = emit(intent, assign(intent)).map((node) => node.type);
    expect(types.filter((type) => type === "forgejo")).toHaveLength(1);
    expect(types.filter((type) => type === "komodo")).toHaveLength(1);
    // One tunnel per host, shared across all apps on that host.
    expect(types.filter((type) => type === "tunnel")).toHaveLength(1);
});

test("an app exposed through a cloudflare with no zone throws", () => {
    const intent: IntentSet = {
        hosts: [host],
        clouds: [],
        apps: [{ id: "app", on: "host", expose: "ghost", environments: { prod: { domain: "app.example.com", branch: "main" } } }],
    };
    expect(() => emit(intent, assign(intent))).toThrow('cloudflare "ghost" has no zone');
});

test("an unsupported option assignment throws", () => {
    const intent: IntentSet = {
        hosts: [host],
        clouds: [cloud],
        apps: [{ id: "app", on: "host", expose: "cf", environments: { prod: { domain: "app.example.com", branch: "main" } } }],
    };
    const byNeed = new Map(assign(intent).byNeed);
    byNeed.set("source-control:host", "gitlab");
    expect(() => emit(intent, { byNeed })).toThrow('unsupported option "gitlab"');
});

test("notify derives a Forgejo webhook (CI) and a Komodo alerter (CD), wired to the app's stack", () => {
    const intent: IntentSet = {
        hosts: [host],
        clouds: [cloud],
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
        hosts: [host],
        clouds: [cloud],
        apps: [{ id: "app", on: "host", expose: "cf", environments: { prod: { domain: "app.example.com", branch: "main" } } }],
    };

    const types = emit(intent, assign(intent)).map((node) => node.type);
    expect(types.filter((type) => type === "forgejo-notify")).toHaveLength(0);
    expect(types.filter((type) => type === "komodo-notify")).toHaveLength(0);
});

test("notification sinks are derived per app, while the platform stays shared per host", () => {
    const intent: IntentSet = {
        hosts: [host],
        clouds: [cloud],
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
