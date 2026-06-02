import { expect, test } from "vitest";

import { compile, env, httpOk, toNodeMap } from "./index.js";
import type { RawNode } from "./types.js";

test("env builds an env-sourced secret ref", () => {
    expect(env("TOKEN")).toEqual({ kind: "secret", source: "env", key: "TOKEN" });
});

test("httpOk omits timeout unless provided", () => {
    expect(httpOk("https://x/health")).toEqual({ kind: "readiness", check: "httpOk", url: "https://x/health" });
    expect(httpOk("https://x/health", { timeout: "30s" })).toEqual({ kind: "readiness", check: "httpOk", url: "https://x/health", timeout: "30s" });
});

test("toNodeMap rejects duplicate ids", () => {
    const nodes: RawNode[] = [
        { id: "dup", type: "host", inputs: {}, explicitDependsOn: [] },
        { id: "dup", type: "host", inputs: {}, explicitDependsOn: [] },
    ];
    expect(() => toNodeMap(nodes)).toThrow('duplicate resource id: "dup"');
});

test("compile guards against dependency cycles", () => {
    const nodes = new Map<string, RawNode>([
        ["a", { id: "a", type: "host", inputs: { peer: { kind: "ref", resourceId: "b" } }, explicitDependsOn: [] }],
        ["b", { id: "b", type: "host", inputs: { peer: { kind: "ref", resourceId: "a" } }, explicitDependsOn: [] }],
    ]);
    expect(() => compile(nodes)).toThrow(/dependency cycle/);
});

test("compile rejects references to unknown resources", () => {
    const nodes = new Map<string, RawNode>([
        ["a", { id: "a", type: "host", inputs: { peer: { kind: "ref", resourceId: "ghost" } }, explicitDependsOn: [] }],
    ]);
    expect(() => compile(nodes)).toThrow('references unknown resource "ghost"');
});
