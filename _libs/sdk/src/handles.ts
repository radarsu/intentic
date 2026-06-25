import type { Ref } from "@intentic/graph";
import type { CloudflareInput, EnvironmentInput, HostInput, NotifyInput, ServiceInput } from "@intentic/need-resolver";

// The authoring surface. A developer declares the inventory they have — i.have.host / i.have.cloudflare —
// and what they want — i.want.app (built from source) and i.want.service (an off-the-shelf shared tool).
// The support stack each app requires (git+CI, deploy orchestrator, runner, tunnel, routes) is derived by
// the resolver, never declared here. These handles are the inert refs i.have.* / i.want.* hand back, which
// i.want.app wires `on`/`expose`/`observe` with.

// --- Inventory handles; their output properties are inert refs ---

export interface Host extends Ref<"host"> {
    readonly internalIp: Ref<string>;
    readonly publicIp: Ref<string>;
}

export interface Cloudflare extends Ref<"cloudflare"> {
    readonly zoneId: Ref<string>;
    readonly accountId: Ref<string>;
}

// --- The app, its source repo, and its environments ---

export interface Repo extends Ref<"repo"> {
    readonly cloneUrl: Ref<string>;
    readonly sshUrl: Ref<string>;
}

export interface Deployment extends Ref<"deployment"> {
    readonly internalUrl: Ref<string>;
    readonly url: Ref<string>;
}

export interface App<Names extends string = string> extends Ref<"app"> {
    readonly repo: Repo;
    readonly environments: Readonly<Record<Names, Deployment>>;
}

// --- A shared off-the-shelf service (i.want.service); its output refs are inert, like inventory handles ---

export interface Service extends Ref<"signoz"> {
    readonly url: Ref<string>;
    readonly internalUrl: Ref<string>;
    // The host-internal OTLP endpoint apps send telemetry to; an app wires it via WantAppInput.observe.
    readonly otlpEndpoint: Ref<string>;
}

// --- Intent input. "Wants require haves" is enforced structurally: on: Host, expose: Cloudflare. ---

export interface WantAppInput {
    on: Host;
    expose: Cloudflare;
    notify?: NotifyInput;
    // A service to send this app's telemetry to; the resolver injects its OTLP endpoint into each deployment.
    observe?: Service;
    environments: Record<string, EnvironmentInput>;
}

export interface WantServiceInput extends ServiceInput {
    on: Host;
    expose: Cloudflare;
}

export interface Have {
    host(id: string, input: HostInput): Host;
    cloudflare(id: string, input: CloudflareInput): Cloudflare;
}

export interface Want {
    // `const` so environment names come from the object keys, e.g. App<"staging" | "production">.
    app<const E extends Record<string, EnvironmentInput>>(id: string, input: WantAppInput & { environments: E }): App<keyof E & string>;
    service(id: string, input: WantServiceInput): Service;
}

export interface Stack {
    readonly have: Have;
    readonly want: Want;
}
