// Core authoring-layer types for @puristic/deploy-core.
// INTENT-FIRST surface: a developer declares inventory ("what you have" — i.have.*) and the one thing they
// want ("what you want" — i.want.app). The resolver derives the app's whole support stack (Git+CI, deploy
// orchestrator, routing) at author time into concrete RawNodes, so defineStack still returns a
// DesiredStateGraph. Pure data, no runtime.

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

// --- Inventory handles ("what you have"); their output properties are inert refs ---

export interface Host extends Ref<"host"> {
    readonly internalIp: Ref<string>;
    readonly publicIp: Ref<string>;
}

export interface Cloudflare extends Ref<"cloudflare"> {
    readonly zoneId: Ref<string>;
}

// --- The app and its environments (the only handles i.want.app hands back) ---

export interface Deployment extends Ref<"deployment"> {
    readonly internalUrl: Ref<string>;
    readonly url: Ref<string>;
}

export interface App<Names extends string = string> extends Ref<"app"> {
    readonly environments: Readonly<Record<Names, Deployment>>;
}

// --- Inputs (what the developer passes). "Wants require haves" is enforced structurally: on: Host,
// expose: Cloudflare. The app's Git+CI, deploy orchestrator, and routes are derived, never declared. ---

export interface HostInput {
    address: string;
    user: string;
    sshKey: SecretRef;
    port?: number;
}

export interface CloudflareInput {
    accountId: string;
    apiToken: SecretRef;
    zone: string;
}

export interface EnvironmentInput {
    domain: string;
    branch: string;
    env?: Record<string, Input<string>>;
    readyWhen?: Readiness;
}

export interface WantAppInput {
    on: Host;
    expose: Cloudflare;
    environments: Record<string, EnvironmentInput>;
}

export interface Have {
    host(id: string, input: HostInput): Host;
    cloudflare(id: string, input: CloudflareInput): Cloudflare;
}

export interface Want {
    // `const` so environment names come from the object keys, e.g. App<"staging" | "production">.
    app<const E extends Record<string, EnvironmentInput>>(id: string, input: WantAppInput & { environments: E }): App<keyof E & string>;
}

export interface Stack {
    readonly have: Have;
    readonly want: Want;
}

// --- Internal pre-compilation node (built by the builder, consumed by the compiler) ---

export interface RawNode {
    readonly id: string;
    readonly type: ResourceType;
    readonly inputs: Readonly<Record<string, unknown>>;
    readonly explicitDependsOn: readonly string[];
    readonly readyWhen?: Readiness;
}

// --- Compiled desired-state graph (the serializable output) ---

export type ResourceType = "host" | "cloudflare" | "cf-route" | "forgejo" | "repo" | "forgejo-runner" | "komodo" | "app" | "deployment";

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
    readonly type: ResourceType;
    readonly inputs: Readonly<Record<string, SerializedValue>>;
    readonly dependsOn: readonly string[];
    readonly readyWhen?: SerializedReadiness;
}

export interface DesiredStateGraph {
    readonly version: 1;
    readonly resources: Readonly<Record<string, ResourceNode>>;
}
