import { env } from "@puristic/deploy-protocol";
import { expect, test } from "vitest";

import type { IntentSet } from "./intent.js";
import { deriveNeeds } from "./needs.js";

const cloud = { id: "cf", input: { accountId: "a", apiToken: env("T"), zone: "example.com" } };
const host = { id: "host", input: { address: "1.2.3.4", user: "deploy", sshKey: env("K") } };

test("an app derives the four host capabilities plus a domain", () => {
    const intent: IntentSet = {
        hosts: [host],
        clouds: [cloud],
        apps: [{ id: "app", on: "host", expose: "cf", environments: { prod: { domain: "app.example.com", branch: "main" } } }],
    };

    expect(deriveNeeds(intent)).toEqual([
        { capability: "source-control", scope: "host" },
        { capability: "docker-registry", scope: "host" },
        { capability: "infra-control", scope: "host" },
        { capability: "deployment-target", scope: "host" },
        { capability: "domain", scope: "cf" },
    ]);
});

test("apps on the same host and cloud collapse to one set of needs", () => {
    const intent: IntentSet = {
        hosts: [host],
        clouds: [cloud],
        apps: [
            { id: "one", on: "host", expose: "cf", environments: { prod: { domain: "one.example.com", branch: "main" } } },
            { id: "two", on: "host", expose: "cf", environments: { prod: { domain: "two.example.com", branch: "main" } } },
        ],
    };

    expect(deriveNeeds(intent)).toHaveLength(5);
});

test("apps on distinct hosts derive host-scoped needs per host", () => {
    const intent: IntentSet = {
        hosts: [host, { id: "host2", input: { address: "5.6.7.8", user: "deploy", sshKey: env("K") } }],
        clouds: [cloud],
        apps: [
            { id: "one", on: "host", expose: "cf", environments: { prod: { domain: "one.example.com", branch: "main" } } },
            { id: "two", on: "host2", expose: "cf", environments: { prod: { domain: "two.example.com", branch: "main" } } },
        ],
    };

    const needs = deriveNeeds(intent);
    expect(needs.filter((need) => need.capability === "source-control").map((need) => need.scope)).toEqual(["host", "host2"]);
    expect(needs.filter((need) => need.capability === "domain")).toHaveLength(1);
});
