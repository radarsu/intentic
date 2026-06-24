import { topoSort } from "./topo.js";
import type { DesiredStateGraph, RawNode, Readiness, Ref, SecretRef } from "./types.js";

export const env = (key: string): SecretRef => Object.freeze({ kind: "secret", source: "env", key });

export const httpOk = (url: string | Ref<string>, options?: { timeout?: string; status?: number }): Readiness =>
    Object.freeze({
        kind: "readiness",
        check: "httpOk",
        url,
        ...(options?.timeout !== undefined ? { timeout: options.timeout } : {}),
        ...(options?.status !== undefined ? { status: options.status } : {}),
    });

export const linearize = (graph: DesiredStateGraph): string[] => {
    const ids = Object.keys(graph.resources);
    const dependsOn = new Map<string, readonly string[]>();
    for (const id of ids) {
        dependsOn.set(id, graph.resources[id]?.dependsOn ?? []);
    }
    return topoSort(ids, dependsOn);
};

// Fold a resolver's RawNode list into the id-keyed map compile() consumes, rejecting duplicate ids.
export const toNodeMap = (nodes: readonly RawNode[]): Map<string, RawNode> => {
    const map = new Map<string, RawNode>();
    for (const node of nodes) {
        if (map.has(node.id)) {
            throw new Error(`duplicate resource id: "${node.id}"`);
        }
        map.set(node.id, node);
    }
    return map;
};

export { compile } from "./compile.js";
export { isRef, makeRef, refKey } from "./ref.js";
export { formatStamp, parseStamp, STAMP_KEY } from "./stamp.js";

export type { DesiredStateGraph, Input, RawNode, Readiness, Ref, ResourceNode, SecretRef, SerializedReadiness, SerializedValue } from "./types.js";
