import { makeRef } from "@intentic/graph";
import type {
    AppIntent,
    BackupInput,
    BackupIntent,
    CloudflareInput,
    CloudflareIntent,
    EnvironmentInput,
    GitHubInput,
    GitHubIntent,
    HostInput,
    HostIntent,
    IntentSet,
    ServiceIntent,
    TeamIntent,
    UserInput,
    UserIntent,
} from "@intentic/need-resolver";
import { deploymentId, repoId } from "@intentic/state-resolver";
import type {
    App,
    Backup,
    Cloudflare,
    Deployment,
    GitHub,
    Host,
    Repo,
    Service,
    Stack,
    Team,
    User,
    WantAppInput,
    WantServiceInput,
    WantTeamInput,
} from "./handles.js";

// The builder is a pure intent recorder: i.have.* / i.want.app record what was declared and hand back typed
// handles for wiring. No derivation happens here — that is the resolver's job. Multiple hosts are supported
// (one control plane is derived); there is a single Cloudflare account. The App handle's per-environment
// ids come from the same deploymentId() the resolver uses, so they cannot drift.
export const createStack = (): { stack: Stack; intent: IntentSet } => {
    const claimed = new Set<string>();
    const claim = (id: string): void => {
        if (claimed.has(id)) {
            throw new Error(`duplicate resource id: "${id}"`);
        }
        claimed.add(id);
    };

    const users: UserIntent[] = [];
    const teams: TeamIntent[] = [];
    const apps: AppIntent[] = [];
    const services: ServiceIntent[] = [];
    const hosts: HostIntent[] = [];
    const intent: {
        hosts: HostIntent[];
        cloudflare?: CloudflareIntent;
        github?: GitHubIntent;
        backup?: BackupIntent;
        users: UserIntent[];
        teams: TeamIntent[];
        apps: AppIntent[];
        services: ServiceIntent[];
    } = { hosts, users, teams, apps, services };

    const host = (id: string, input: HostInput): Host => {
        claim(id);
        hosts.push({ id, input });
        return Object.freeze({ ...makeRef(id), internalIp: makeRef<string>(id, "internalIp"), publicIp: makeRef<string>(id, "publicIp") }) as Host;
    };

    const cloudflare = (id: string, input: CloudflareInput): Cloudflare => {
        if (intent.cloudflare !== undefined) {
            throw new Error("a Cloudflare account is already declared; intentic supports a single Cloudflare account");
        }
        claim(id);
        intent.cloudflare = { id, input };
        return Object.freeze({ ...makeRef(id), zoneId: makeRef<string>(id, "zoneId"), accountId: makeRef<string>(id, "accountId") }) as Cloudflare;
    };

    const backup = (id: string, input: BackupInput): Backup => {
        if (intent.backup !== undefined) {
            throw new Error("a backup is already declared; intentic supports a single backup destination");
        }
        claim(id);
        intent.backup = { id, input };
        return Object.freeze(makeRef(id)) as Backup;
    };

    const github = (id: string, input: GitHubInput): GitHub => {
        if (intent.github !== undefined) {
            throw new Error("a GitHub account is already declared; intentic supports a single GitHub account");
        }
        claim(id);
        intent.github = { id, input };
        return Object.freeze({ ...makeRef(id), owner: makeRef<string>(id, "owner") }) as GitHub;
    };

    const app = <const E extends Record<string, EnvironmentInput>>(id: string, input: WantAppInput & { environments: E }): App<keyof E & string> => {
        claim(id);
        apps.push({
            id,
            on: input.on.resourceId,
            expose: input.expose.resourceId,
            ...(input.notify !== undefined ? { notify: input.notify } : {}),
            ...(input.observe !== undefined ? { observe: input.observe.resourceId } : {}),
            ...(input.teams !== undefined ? { teams: input.teams.map((grant) => ({ team: grant.team.resourceId, role: grant.role })) } : {}),
            environments: input.environments,
        });

        const environments: Record<string, Deployment> = {};
        for (const name of Object.keys(input.environments)) {
            const did = deploymentId(id, name);
            environments[name] = Object.freeze({
                ...makeRef(did),
                internalUrl: makeRef<string>(did, "internalUrl"),
                url: makeRef<string>(did, "url"),
            }) as Deployment;
        }

        const rid = repoId(id);
        const repo = Object.freeze({ ...makeRef(rid), cloneUrl: makeRef<string>(rid, "cloneUrl"), sshUrl: makeRef<string>(rid, "sshUrl") }) as Repo;
        return Object.freeze({ ...makeRef(id), repo, environments: Object.freeze(environments) }) as App<keyof E & string>;
    };

    const service = (id: string, input: WantServiceInput): Service => {
        claim(id);
        services.push({ id, kind: input.kind, on: input.on.resourceId, expose: input.expose.resourceId, domain: input.domain });
        return Object.freeze({
            ...makeRef(id),
            url: makeRef<string>(id, "url"),
            internalUrl: makeRef<string>(id, "internalUrl"),
            otlpEndpoint: makeRef<string>(id, "otlpEndpoint"),
        }) as Service;
    };

    const user = (id: string, input: UserInput): User => {
        claim(id);
        users.push({ id, input });
        return Object.freeze(makeRef(id)) as User;
    };

    const team = (id: string, input: WantTeamInput): Team => {
        claim(id);
        teams.push({ id, input: { members: input.members.map((member) => member.resourceId), komodo: input.komodo } });
        return Object.freeze(makeRef(id)) as Team;
    };

    const stack: Stack = { have: { host, cloudflare, github, backup }, want: { app, service, user, team } };
    return { stack, intent };
};
