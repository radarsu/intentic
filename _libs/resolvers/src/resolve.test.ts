import { env } from "@puristic/deploy-protocol";
import { expect, test } from "vitest";

import type { IntentSet } from "./intent.js";
import { resolve } from "./resolve.js";

const cloud = { id: "cf", input: { accountId: "a", apiToken: env("T"), zone: "example.com" } };
const host = { id: "host", input: { address: "1.2.3.4", user: "deploy", sshKey: env("K") } };

test("resolve derives the full support stack for a two-environment app", () => {
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

    expect(resolve(intent).map((node) => node.id)).toEqual([
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
        "app.production",
        "cf-app-example-com",
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

    const types = resolve(intent).map((node) => node.type);
    expect(types.filter((type) => type === "forgejo")).toHaveLength(1);
    expect(types.filter((type) => type === "komodo")).toHaveLength(1);
});

test("an app exposed through a cloudflare with no zone throws", () => {
    const intent: IntentSet = {
        hosts: [host],
        clouds: [],
        apps: [{ id: "app", on: "host", expose: "ghost", environments: { prod: { domain: "app.example.com", branch: "main" } } }],
    };
    expect(() => resolve(intent)).toThrow('cloudflare "ghost" has no zone');
});
