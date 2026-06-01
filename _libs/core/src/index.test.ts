import { expect, test } from "vitest";

import { defineStack, env, httpOk, linearize } from "./index.js";
import type { Ref, Server } from "./index.js";

const ghostServer = (id: string): Server => ({ kind: "ref", resourceId: id }) as unknown as Server;
const ghostRef = (id: string): Ref<string> => ({ kind: "ref", resourceId: id }) as unknown as Ref<string>;

test("env builds an env-sourced secret ref", () => {
    expect(env("TOKEN")).toEqual({ kind: "secret", source: "env", key: "TOKEN" });
});

test("httpOk omits timeout unless provided", () => {
    expect(httpOk("https://x/health")).toEqual({ kind: "readiness", check: "httpOk", url: "https://x/health" });
    expect(httpOk("https://x/health", { timeout: "30s" })).toEqual({ kind: "readiness", check: "httpOk", url: "https://x/health", timeout: "30s" });
});

test("refs and secrets serialize, and readyWhen stays separate from dependsOn", () => {
    const graph = defineStack((s) => {
        const host = s.server("host", { host: "1.2.3.4", user: "deploy", sshKey: env("HOST_SSH_KEY") });
        s.forgejo("forgejo", {
            server: host,
            domain: "git.example.com",
            adminUser: "admin",
            adminPassword: env("FORGEJO_ADMIN_PASSWORD"),
            readyWhen: httpOk("https://git.example.com/api/healthz", { timeout: "120s" }),
        });
    });

    expect(graph.resources["forgejo"]?.inputs["server"]).toEqual({ $ref: "host" });
    expect(graph.resources["host"]?.inputs["sshKey"]).toEqual({ $secret: { source: "env", key: "HOST_SSH_KEY" } });
    expect(graph.resources["forgejo"]?.dependsOn).toEqual(["host"]);
    expect(graph.resources["forgejo"]?.readyWhen).toEqual({ check: "httpOk", url: "https://git.example.com/api/healthz", timeout: "120s" });
});

test("duplicate resource id throws", () => {
    expect(() =>
        defineStack((s) => {
            s.server("dup", { host: "1.2.3.4", user: "deploy", sshKey: env("K") });
            s.server("dup", { host: "5.6.7.8", user: "deploy", sshKey: env("K") });
        }),
    ).toThrow('duplicate resource id: "dup"');
});

test("reference to an unknown resource throws", () => {
    expect(() =>
        defineStack((s) => {
            s.forgejoRunner("runner", { server: ghostServer("nope"), instanceUrl: ghostRef("nope"), token: ghostRef("nope") });
        }),
    ).toThrow('references unknown resource "nope"');
});

test("a dependency cycle throws", () => {
    expect(() =>
        defineStack((s) => {
            s.forgejoRunner("a", { server: ghostServer("b"), instanceUrl: ghostRef("b"), token: ghostRef("b") });
            s.forgejoRunner("b", { server: ghostServer("a"), instanceUrl: ghostRef("a"), token: ghostRef("a") });
        }),
    ).toThrow(/dependency cycle/);
});

test("linearize derives a topological order (dependency before dependent)", () => {
    const graph = defineStack((s) => {
        const host = s.server("host", { host: "1.2.3.4", user: "deploy", sshKey: env("K") });
        s.forgejo("forgejo", { server: host, domain: "git.example.com", adminUser: "admin", adminPassword: env("P") });
    });

    expect(linearize(graph)).toEqual(["host", "forgejo"]);
});
