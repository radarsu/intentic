import type { Ref } from "@intentic/graph";
import type { EnvironmentInput, NotifyInput } from "@intentic/resolvers";

// The authoring surface. A developer declares only what they want — i.want.app — and the support stack it
// requires (git+CI, deploy orchestrator, the host it runs on, the Cloudflare it's exposed through) is
// derived by the resolver and reconciled as resources in the target artifact; their connection values are
// filled at the decision/PR step, never authored here. These handles are the inert refs i.want.app hands back.

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

// --- Intent input: the one thing you want, an app shipped to one or more environments. ---

export interface WantAppInput {
    notify?: NotifyInput;
    environments: Record<string, EnvironmentInput>;
}

export interface Want {
    // `const` so environment names come from the object keys, e.g. App<"staging" | "production">.
    app<const E extends Record<string, EnvironmentInput>>(id: string, input: WantAppInput & { environments: E }): App<keyof E & string>;
}

export interface Stack {
    readonly want: Want;
}
