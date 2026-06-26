import type { Ref } from "@intentic/graph";
import type {
    BackupInput,
    CloudflareInput,
    DiscordInput,
    EnvironmentInput,
    ForgejoRole,
    GitHubInput,
    HostInput,
    KomodoRole,
    ServiceInput,
    UserInput,
} from "@intentic/need-resolver";

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

export interface GitHub extends Ref<"github"> {
    readonly owner: Ref<string>;
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

// --- People and teams (i.want.user / i.want.team). Identity handles: bare refs with no output props —
// nothing references an output off them (usernames and org names are authored or deterministic literals the
// resolver passes around directly), they exist only to be wired into teams and app grants. ---

export type User = Ref<"forgejo-user">;
export type Team = Ref<"forgejo-team">;

// The backup destination (i.have.backup). A bare ref like User/Team — nothing references an output off it;
// it exists only to record that backups are wanted and where they go.
export type Backup = Ref<"backup">;

// The Discord back-communication channel (i.have.discord). A bare ref — the provider owns the guild/channels
// structure; the resolver references its webhook outputs to wire notifications.
export type Discord = Ref<"discord">;

// A team's members are User handles; its Komodo role applies to the deployments of the apps it manages.
export interface WantTeamInput {
    members: readonly User[];
    komodo: KomodoRole;
}

// An app's grant of a team at a Forgejo role. The first grant on an app owns its repo.
export interface AppTeamGrant {
    team: Team;
    role: ForgejoRole;
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
    // The Discord channel this app's CI/CD alerts are posted to; wired like expose/observe.
    notify?: Discord;
    // A service to send this app's telemetry to; the resolver injects its OTLP endpoint into each deployment.
    observe?: Service;
    // The teams that manage this app, each at a Forgejo role. The first grant's team owns the repo (its org is
    // the repo + registry namespace); omitted/empty falls back to the single admin owner.
    teams?: readonly AppTeamGrant[];
    environments: Record<string, EnvironmentInput>;
}

export interface WantServiceInput extends ServiceInput {
    on: Host;
    expose: Cloudflare;
}

export interface Have {
    host(id: string, input: HostInput): Host;
    cloudflare(id: string, input: CloudflareInput): Cloudflare;
    github(id: string, input: GitHubInput): GitHub;
    backup(id: string, input: BackupInput): Backup;
    discord(id: string, input: DiscordInput): Discord;
}

export interface Want {
    // `const` so environment names come from the object keys, e.g. App<"staging" | "production">.
    app<const E extends Record<string, EnvironmentInput>>(id: string, input: WantAppInput & { environments: E }): App<keyof E & string>;
    service(id: string, input: WantServiceInput): Service;
    user(id: string, input: UserInput): User;
    team(id: string, input: WantTeamInput): Team;
}

export interface Stack {
    readonly have: Have;
    readonly want: Want;
}
