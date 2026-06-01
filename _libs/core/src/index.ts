import { compile } from "./compile.js";
import { createStack } from "./stack.js";
import { topoSort } from "./topo.js";
import type { DesiredStateGraph, Readiness, Ref, SecretRef, Stack } from "./types.js";

export const defineStack = (build: (s: Stack) => void): DesiredStateGraph => {
    const { stack, nodes } = createStack();
    build(stack);
    return compile(nodes);
};

export const linearize = (graph: DesiredStateGraph): string[] => {
    const ids = Object.keys(graph.resources);
    const dependsOn = new Map<string, readonly string[]>();
    for (const id of ids) {
        dependsOn.set(id, graph.resources[id]?.dependsOn ?? []);
    }
    return topoSort(ids, dependsOn);
};

export const env = (key: string): SecretRef => Object.freeze({ kind: "secret", source: "env", key });

export const httpOk = (url: string | Ref<string>, options?: { timeout?: string; status?: number }): Readiness =>
    Object.freeze({
        kind: "readiness",
        check: "httpOk",
        url,
        ...(options?.timeout !== undefined ? { timeout: options.timeout } : {}),
        ...(options?.status !== undefined ? { status: options.status } : {}),
    });

export type {
    App,
    Cloudflare,
    Deployment,
    DesiredStateGraph,
    Forgejo,
    ForgejoRunner,
    Input,
    Komodo,
    Readiness,
    Ref,
    Repo,
    ResourceNode,
    ResourceType,
    Route,
    SecretRef,
    SerializedReadiness,
    SerializedValue,
    Server,
    Stack,
} from "./types.js";
