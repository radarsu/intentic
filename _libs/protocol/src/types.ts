// The desired-state intermediate representation for @puristic/deploy. This layer is product-agnostic:
// it defines refs, secrets, readiness, and the serializable graph, but knows nothing about which kinds
// of resource exist. A resource node's `type` is an opaque `string` here — the resolver layer owns the
// closed vocabulary of kinds and guarantees only valid ones are emitted.

export interface Ref<T> {
    readonly kind: "ref";
    readonly resourceId: string;
    readonly output?: string;
    readonly __type?: T;
}

export interface SecretRef {
    readonly kind: "secret";
    readonly source: "env";
    readonly key: string;
}

export interface Readiness {
    readonly kind: "readiness";
    readonly check: "httpOk";
    readonly url: string | Ref<string>;
    readonly timeout?: string;
    readonly status?: number;
}

export type Input<T> = T | Ref<T> | (T extends string ? SecretRef : never);

// --- Pre-compilation node (emitted by a resolver, consumed by the compiler) ---

export interface RawNode {
    readonly id: string;
    readonly type: string;
    readonly inputs: Readonly<Record<string, unknown>>;
    readonly explicitDependsOn: readonly string[];
    readonly readyWhen?: Readiness;
}

// --- Compiled desired-state graph (the serializable output) ---

export type SerializedValue =
    | string
    | number
    | boolean
    | { readonly $ref: string }
    | { readonly $secret: { readonly source: "env"; readonly key: string } }
    | readonly SerializedValue[]
    | { readonly [key: string]: SerializedValue };

export interface SerializedReadiness {
    readonly check: "httpOk";
    readonly url: string | { readonly $ref: string };
    readonly timeout?: string;
    readonly status?: number;
}

export interface ResourceNode {
    readonly id: string;
    readonly type: string;
    readonly inputs: Readonly<Record<string, SerializedValue>>;
    readonly dependsOn: readonly string[];
    readonly readyWhen?: SerializedReadiness;
}

export interface DesiredStateGraph {
    readonly version: 1;
    readonly resources: Readonly<Record<string, ResourceNode>>;
}
