// Core authoring-layer types for @puristic/deploy.
// These describe what a developer declares and what it compiles to. Pure data, no runtime.

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

// --- Resource handles (returned by the builder; their output properties are inert refs) ---

export interface Server extends Ref<"server"> {
    readonly internalIp: Ref<string>;
    readonly publicIp: Ref<string>;
}

export interface Cloudflare extends Ref<"cloudflare"> {
    readonly zoneId: Ref<string>;
    route(routeId: string, input: RouteInput): Route;
}

export interface Route extends Ref<"cf-route"> {
    readonly url: Ref<string>;
}

export interface Forgejo extends Ref<"forgejo"> {
    readonly url: Ref<string>;
    readonly internalUrl: Ref<string>;
    readonly runnerToken: Ref<string>;
    repo(repoId: string, input: RepoInput): Repo;
}

export interface Repo extends Ref<"repo"> {
    readonly cloneUrl: Ref<string>;
    readonly sshUrl: Ref<string>;
}

export type ForgejoRunner = Ref<"forgejo-runner">;

export interface Komodo extends Ref<"komodo"> {
    readonly url: Ref<string>;
    readonly internalUrl: Ref<string>;
    readonly passkey: Ref<string>;
}

export interface Deployment extends Ref<"deployment"> {
    readonly internalUrl: Ref<string>;
    readonly url: Ref<string>;
}

export interface App<Names extends string = string> extends Ref<"app"> {
    readonly environments: Readonly<Record<Names, Deployment>>;
}

export type ResourceHandle = Server | Cloudflare | Route | Forgejo | Repo | ForgejoRunner | Komodo | App | Deployment;

// --- Inputs (what the developer passes to each constructor) ---

export interface ServerInput {
    host: string;
    user: string;
    sshKey: SecretRef;
    port?: number;
}

export interface CloudflareInput {
    accountId: string;
    apiToken: SecretRef;
    zone: string;
}

export interface RouteInput {
    hostname: string;
    target: Ref<string>;
}

export interface ForgejoInput {
    server: Server;
    domain: string;
    adminUser: string;
    adminPassword: SecretRef;
    readyWhen?: Readiness;
    dependsOn?: ResourceHandle[];
}

export interface RepoInput {
    name: string;
    private?: boolean;
}

export interface ForgejoRunnerInput {
    server: Server;
    instanceUrl: Ref<string>;
    token: Ref<string>;
}

export interface KomodoInput {
    server: Server;
    domain: string;
    forgejoUrl: Ref<string>;
    runnerToken: Ref<string>;
    adminPassword: SecretRef;
    readyWhen?: Readiness;
}

export interface EnvironmentInput {
    name: string;
    branch: string;
    domain: string;
    server: Server;
    env?: Record<string, Input<string>>;
    readyWhen?: Readiness;
}

export interface AppInput<E extends readonly EnvironmentInput[] = readonly EnvironmentInput[]> {
    source: Ref<string>;
    deployer: Komodo;
    environments: E;
}

export interface Stack {
    server(id: string, input: ServerInput): Server;
    cloudflare(id: string, input: CloudflareInput): Cloudflare;
    forgejo(id: string, input: ForgejoInput): Forgejo;
    forgejoRunner(id: string, input: ForgejoRunnerInput): ForgejoRunner;
    komodo(id: string, input: KomodoInput): Komodo;
    app<const E extends readonly EnvironmentInput[]>(id: string, input: AppInput<E>): App<E[number]["name"]>;
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

export type ResourceType =
    | "server"
    | "cloudflare"
    | "cf-route"
    | "forgejo"
    | "repo"
    | "forgejo-runner"
    | "komodo"
    | "app"
    | "deployment";

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
