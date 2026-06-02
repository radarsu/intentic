import type { Ref } from "@puristic/deploy-protocol";
import type { CloudflareInput, EnvironmentInput, HostInput, NotifyInput } from "@puristic/deploy-resolvers";

// The authoring surface. A developer declares inventory ("what you have" — i.have.*) and the one thing
// they want ("what you want" — i.want.app); the support stack each app requires is derived by the
// resolver, never declared here. These handles are inert refs the author wires `on`/`expose` with.

// --- Inventory handles; their output properties are inert refs ---

export interface Host extends Ref<"host"> {
    readonly internalIp: Ref<string>;
    readonly publicIp: Ref<string>;
}

export interface Cloudflare extends Ref<"cloudflare"> {
    readonly zoneId: Ref<string>;
}

// --- The app, its source repo, and its environments (the handles i.want.app hands back) ---

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

// --- Intent input. "Wants require haves" is enforced structurally: on: Host, expose: Cloudflare. ---

export interface WantAppInput {
    on: Host;
    expose: Cloudflare;
    notify?: NotifyInput;
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
