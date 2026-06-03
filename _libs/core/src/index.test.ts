import type { RawNode } from "@puristic/deploy-protocol";

import { compile, env, httpOk, linearize } from "@puristic/deploy-protocol";
import { expect, test } from "vitest";
import type { Host } from "./index.js";
import { defineStack } from "./index.js";

const ghostHost = (id: string): Host => ({ kind: "ref", resourceId: id }) as unknown as Host;

test("env builds an env-sourced secret ref", () => {
    expect(env("TOKEN")).toEqual({ kind: "secret", source: "env", key: "TOKEN" });
});

test("httpOk omits timeout unless provided", () => {
    expect(httpOk("https://x/health")).toEqual({ kind: "readiness", check: "httpOk", url: "https://x/health" });
    expect(httpOk("https://x/health", { timeout: "30s" })).toEqual({ kind: "readiness", check: "httpOk", url: "https://x/health", timeout: "30s" });
});

test("want.app derives its support stack: refs/secrets serialize and the resolver supplies a default readyWhen", () => {
    const graph = defineStack((i) => {
        const host = i.have.host("host", { address: "1.2.3.4", user: "deploy", sshKey: env("HOST_SSH_KEY") });
        const cf = i.have.cloudflare("cf", { accountId: "a", apiToken: env("T"), zone: "example.com" });
        i.want.app("app", { on: host, expose: cf, environments: { prod: { domain: "app.example.com", branch: "main" } } });
    });

    // The forgejo node is derived from want.app, wired to the host, with a zone-derived domain + default health gate.
    expect(graph.resources["host-git"]?.inputs["server"]).toEqual({ $ref: "host" });
    expect(graph.resources["host"]?.inputs["sshKey"]).toEqual({ $secret: { source: "env", key: "HOST_SSH_KEY" } });
    expect(graph.resources["host-git"]?.dependsOn).toEqual(["host"]);
    expect(graph.resources["host-git"]?.readyWhen).toEqual({ check: "httpOk", url: { $ref: "host-git.internalUrl" }, timeout: "120s" });
});

test("duplicate resource id throws", () => {
    expect(() =>
        defineStack((i) => {
            i.have.host("dup", { address: "1.2.3.4", user: "deploy", sshKey: env("K") });
            i.have.host("dup", { address: "5.6.7.8", user: "deploy", sshKey: env("K") });
        }),
    ).toThrow('duplicate resource id: "dup"');
});

test("an app targeting an undeclared host throws", () => {
    expect(() =>
        defineStack((i) => {
            const cf = i.have.cloudflare("cf", { accountId: "a", apiToken: env("T"), zone: "example.com" });
            i.want.app("app", { on: ghostHost("nope"), expose: cf, environments: { prod: { domain: "x.example.com", branch: "main" } } });
        }),
    ).toThrow('app "app" targets unknown host "nope"');
});

test("a dependency cycle throws", () => {
    // Auto-derived ids cannot form an authored cycle, so exercise the compile-layer guard directly.
    const nodes = new Map<string, RawNode>([
        ["a", { id: "a", type: "host", inputs: { peer: { kind: "ref", resourceId: "b" } }, explicitDependsOn: [] }],
        ["b", { id: "b", type: "host", inputs: { peer: { kind: "ref", resourceId: "a" } }, explicitDependsOn: [] }],
    ]);
    expect(() => compile(nodes)).toThrow(/dependency cycle/);
});

test("linearize derives a topological order (dependency before dependent)", () => {
    const graph = defineStack((i) => {
        const host = i.have.host("host", { address: "1.2.3.4", user: "deploy", sshKey: env("K") });
        const cf = i.have.cloudflare("cf", { accountId: "a", apiToken: env("T"), zone: "example.com" });
        i.want.app("app", { on: host, expose: cf, environments: { prod: { domain: "app.example.com", branch: "main" } } });
    });

    const order = linearize(graph);
    expect(order[0]).toBe("host");
    expect([...order].sort()).toEqual(Object.keys(graph.resources).sort());
});

test("apps on the same host share one derived platform", () => {
    const graph = defineStack((i) => {
        const host = i.have.host("host", { address: "1.2.3.4", user: "deploy", sshKey: env("K") });
        const cf = i.have.cloudflare("cf", { accountId: "a", apiToken: env("T"), zone: "example.com" });
        i.want.app("app-one", { on: host, expose: cf, environments: { prod: { domain: "one.example.com", branch: "main" } } });
        i.want.app("app-two", { on: host, expose: cf, environments: { prod: { domain: "two.example.com", branch: "main" } } });
    });

    // One shared Forgejo + Komodo for the host, not one per app.
    const types = Object.values(graph.resources).map((node) => node.type);
    expect(types.filter((type) => type === "forgejo")).toHaveLength(1);
    expect(types.filter((type) => type === "komodo")).toHaveLength(1);
    // Both apps deploy through the same orchestrator.
    expect(graph.resources["app-one"]?.inputs["deployer"]).toEqual({ $ref: "host-deploy" });
    expect(graph.resources["app-two"]?.inputs["deployer"]).toEqual({ $ref: "host-deploy" });
});
