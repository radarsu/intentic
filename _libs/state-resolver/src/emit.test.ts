import { env, makeRef } from "@intentic/graph";
import type { CloudflareIntent, HostIntent, IntentSet } from "@intentic/need-resolver";
import { needKey, resolveNeeds } from "@intentic/need-resolver";
import { expect, test } from "vitest";

import { forgejoCatalog } from "./catalog.js";
import type { Assignment } from "./emit.js";
import { emit } from "./emit.js";

// The authored inventory every test intent wires its apps to (on: "host", expose: "cf").
const host: HostIntent = { id: "host", input: { address: "203.0.113.10", user: "deploy", sshKey: env("HOST_SSH_KEY") } };
const cloudflare: CloudflareIntent = { id: "cf", input: { apiToken: env("CLOUDFLARE_API_TOKEN") } };

// The full single-combination assignment for an intent under the default catalog — the one combo emit
// supports today.
const assign = (intent: IntentSet): Assignment => {
    const byNeed = new Map<string, string>();
    for (const need of resolveNeeds(intent)) {
        const option = forgejoCatalog.optionsFor(need.capability)[0];
        if (option === undefined) {
            throw new Error(`no option for ${need.capability}`);
        }
        byNeed.set(needKey(need), option.id);
    }
    return { byNeed };
};

test("emit derives the full support stack for a two-environment app", () => {
    const intent: IntentSet = {
        hosts: [host],
        cloudflare,
        users: [],
        teams: [],
        services: [],
        backings: [],
        apps: [
            {
                id: "app",
                on: "host",
                expose: "cf",
                environments: {
                    staging: { domain: "staging.example.com", branch: "develop" },
                    production: { domain: "app.example.com", branch: "main" },
                },
            },
        ],
    };

    expect(emit(intent, assign(intent), "example.com").map((node) => node.id)).toEqual([
        "host",
        "cf",
        "host-git",
        "host-git-runner",
        "host-deploy",
        "cf-git-example-com",
        "cf-deploy-example-com",
        "app-repo",
        "app.staging-ci",
        "app.staging",
        "cf-staging-example-com",
        "app.production-ci",
        "app.production",
        "cf-app-example-com",
        "host-tunnel",
    ]);
});

test("apps share one derived platform", () => {
    const intent: IntentSet = {
        hosts: [host],
        cloudflare,
        users: [],
        teams: [],
        services: [],
        backings: [],
        apps: [
            { id: "one", on: "host", expose: "cf", environments: { prod: { domain: "one.example.com", branch: "main" } } },
            { id: "two", on: "host", expose: "cf", environments: { prod: { domain: "two.example.com", branch: "main" } } },
        ],
    };

    const types = emit(intent, assign(intent), "example.com").map((node) => node.type);
    expect(types.filter((type) => type === "forgejo")).toHaveLength(1);
    expect(types.filter((type) => type === "komodo")).toHaveLength(1);
    // One tunnel for the shared host, across all apps.
    expect(types.filter((type) => type === "tunnel")).toHaveLength(1);
});

test("an unsupported option assignment throws", () => {
    const intent: IntentSet = {
        hosts: [host],
        cloudflare,
        users: [],
        teams: [],
        services: [],
        backings: [],
        apps: [{ id: "app", on: "host", expose: "cf", environments: { prod: { domain: "app.example.com", branch: "main" } } }],
    };
    const byNeed = new Map(assign(intent).byNeed);
    byNeed.set("source-control:host", "gitlab");
    expect(() => emit(intent, { byNeed }, "example.com")).toThrow('unsupported option "gitlab"');
});

test("app with notify: discord derives forgejo-notify (CI) + komodo-notify (CD), wired to the discord node's webhooks", () => {
    const intent: IntentSet = {
        hosts: [host],
        cloudflare,
        discord: { id: "discord", input: { botToken: env("DISCORD_BOT_TOKEN") } },
        users: [],
        teams: [],
        services: [],
        backings: [],
        apps: [
            {
                id: "app",
                on: "host",
                expose: "cf",
                notify: "discord",
                environments: { prod: { domain: "app.example.com", branch: "main" } },
            },
        ],
    };

    const nodes = emit(intent, assign(intent), "example.com");
    const forgejoNotify = nodes.find((node) => node.id === "app-repo-notify");
    const komodoNotify = nodes.find((node) => node.id === "app-notify");

    expect(forgejoNotify?.type).toBe("forgejo-notify");
    expect(forgejoNotify?.explicitDependsOn).toContain("discord");
    expect(komodoNotify?.type).toBe("komodo-notify");
    expect(komodoNotify?.explicitDependsOn).toContain("discord");

    // The webhook comes from the discord provider's per-app output, not a raw env secret.
    expect(forgejoNotify?.inputs["webhook"]).toEqual(makeRef("discord", "appWebhook:app"));
    expect(komodoNotify?.inputs["webhook"]).toEqual(makeRef("discord", "appWebhook:app"));
});

test("app without notify derives no notification sinks even when discord is declared", () => {
    const intent: IntentSet = {
        hosts: [host],
        cloudflare,
        discord: { id: "discord", input: { botToken: env("DISCORD_BOT_TOKEN") } },
        users: [],
        teams: [],
        services: [],
        backings: [],
        apps: [{ id: "app", on: "host", expose: "cf", environments: { prod: { domain: "app.example.com", branch: "main" } } }],
    };

    const types = emit(intent, assign(intent), "example.com").map((node) => node.type);
    expect(types.filter((type) => type === "forgejo-notify")).toHaveLength(0);
    expect(types.filter((type) => type === "komodo-notify")).toHaveLength(0);
    // The discord node IS emitted but its apps list is empty (no app references it).
    expect(types.filter((type) => type === "discord")).toHaveLength(1);
    expect(emit(intent, assign(intent), "example.com").find((node) => node.type === "discord")?.inputs["apps"]).toEqual([]);
});

test("no discord declared derives no notification sinks", () => {
    const intent: IntentSet = {
        hosts: [host],
        cloudflare,
        users: [],
        teams: [],
        services: [],
        backings: [],
        apps: [{ id: "app", on: "host", expose: "cf", environments: { prod: { domain: "app.example.com", branch: "main" } } }],
    };

    const types = emit(intent, assign(intent), "example.com").map((node) => node.type);
    expect(types.filter((type) => type === "forgejo-notify")).toHaveLength(0);
    expect(types.filter((type) => type === "komodo-notify")).toHaveLength(0);
    expect(types.filter((type) => type === "discord")).toHaveLength(0);
});

test("notification sinks are derived only for apps that wire notify, while the platform stays shared", () => {
    const intent: IntentSet = {
        hosts: [host],
        cloudflare,
        discord: { id: "discord", input: { botToken: env("DISCORD_BOT_TOKEN") } },
        users: [],
        teams: [],
        services: [],
        backings: [],
        apps: [
            {
                id: "one",
                on: "host",
                expose: "cf",
                notify: "discord",
                environments: { prod: { domain: "one.example.com", branch: "main" } },
            },
            {
                id: "two",
                on: "host",
                expose: "cf",
                environments: { prod: { domain: "two.example.com", branch: "main" } },
            },
        ],
    };

    const types = emit(intent, assign(intent), "example.com").map((node) => node.type);
    // Only "one" wires notify — "two" opts out.
    expect(types.filter((type) => type === "forgejo-notify")).toHaveLength(1);
    expect(types.filter((type) => type === "komodo-notify")).toHaveLength(1);
    expect(types.filter((type) => type === "forgejo")).toHaveLength(1);
    expect(types.filter((type) => type === "komodo")).toHaveLength(1);
    expect(types.filter((type) => type === "discord")).toHaveLength(1);

    // The discord node carries only the notified app.
    const discordNode = emit(intent, assign(intent), "example.com").find((node) => node.type === "discord");
    expect(discordNode?.inputs["apps"]).toEqual(["one"]);
});

test("a services-only intent emits the service + its route + tunnel, but no app platform", () => {
    const intent: IntentSet = {
        hosts: [host],
        cloudflare,
        users: [],
        teams: [],
        services: [{ id: "obs", kind: "signoz", on: "host", expose: "cf", domain: "signoz.example.com" }],
        backings: [],
        apps: [],
    };

    const nodes = emit(intent, assign(intent), "example.com");
    expect(nodes.map((node) => node.id)).toEqual(["host", "cf", "obs", "cf-signoz-example-com", "host-tunnel"]);
    const signoz = nodes.find((node) => node.id === "obs");
    expect(signoz?.type).toBe("signoz");
    expect(signoz?.inputs["domain"]).toBe("signoz.example.com");
    // The build platform exists only to ship apps from source — a services-only intent skips it.
    expect(nodes.some((node) => node.type === "forgejo")).toBe(false);
    expect(nodes.some((node) => node.type === "komodo")).toBe(false);
    // The service's dashboard port is aggregated onto the host tunnel's ingress.
    expect(nodes.find((node) => node.id === "host-tunnel")?.inputs["ingress"]).toEqual([{ hostname: "signoz.example.com", port: 8080 }]);
});

test("an app's observe injects the service's OTLP endpoint into each deployment and depends on the service", () => {
    const intent: IntentSet = {
        hosts: [host],
        cloudflare,
        users: [],
        teams: [],
        services: [{ id: "obs", kind: "signoz", on: "host", expose: "cf", domain: "signoz.example.com" }],
        backings: [],
        apps: [
            {
                id: "app",
                on: "host",
                expose: "cf",
                observe: "obs",
                environments: { prod: { domain: "app.example.com", branch: "main", env: { DATABASE_URL: env("DB") } } },
            },
        ],
    };

    const deployment = emit(intent, assign(intent), "example.com").find((node) => node.id === "app.prod");
    // OTLP wiring is spread before the author's env, so an explicit DATABASE_URL survives alongside it.
    expect(deployment?.inputs["env"]).toEqual({
        OTEL_EXPORTER_OTLP_ENDPOINT: makeRef("obs", "otlpEndpoint"),
        OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
        DATABASE_URL: env("DB"),
    });
    expect(deployment?.explicitDependsOn).toContain("obs");
});

test("an app without observe carries no OTLP env and no service dependency", () => {
    const intent: IntentSet = {
        hosts: [host],
        cloudflare,
        users: [],
        teams: [],
        services: [],
        backings: [],
        apps: [{ id: "app", on: "host", expose: "cf", environments: { prod: { domain: "app.example.com", branch: "main" } } }],
    };

    const deployment = emit(intent, assign(intent), "example.com").find((node) => node.id === "app.prod");
    expect(deployment?.inputs["env"]).toBeUndefined();
    expect(deployment?.explicitDependsOn).toEqual(["app.prod-ci", "cf-deploy-example-com"]);
});

test("observing an undeclared service throws", () => {
    const intent: IntentSet = {
        hosts: [host],
        cloudflare,
        users: [],
        teams: [],
        services: [],
        backings: [],
        apps: [{ id: "app", on: "host", expose: "cf", observe: "ghost", environments: { prod: { domain: "app.example.com", branch: "main" } } }],
    };

    expect(() => emit(intent, assign(intent), "example.com")).toThrow('app "app" observes unknown service "ghost"');
});

test("users and teams derive Forgejo accounts + org/team and Komodo users, and the team owns the app's repo", () => {
    const intent: IntentSet = {
        hosts: [host],
        cloudflare,
        users: [{ id: "alice", input: { username: "alice", email: "alice@example.com" } }],
        teams: [{ id: "squad", input: { members: ["alice"], komodo: "execute" } }],
        services: [],
        backings: [],
        apps: [
            {
                id: "app",
                on: "host",
                expose: "cf",
                teams: [{ team: "squad", role: "write" }],
                environments: { prod: { domain: "app.example.com", branch: "main" } },
            },
        ],
    };

    const nodes = emit(intent, assign(intent), "example.com");
    const byId = new Map(nodes.map((node) => [node.id, node]));

    // One identity node of each kind, host-scoped.
    expect(byId.get("host-git-user-alice")?.type).toBe("forgejo-user");
    expect(byId.get("host-deploy-user-alice")?.type).toBe("komodo-user");
    expect(byId.get("host-git-org-squad")?.type).toBe("forgejo-org");
    expect(byId.get("host-git-org-squad-team")?.type).toBe("forgejo-team");

    // The repo is owned by the team's org (its id), and so are the ci/deployment image namespaces.
    expect(byId.get("app-repo")?.inputs["owner"]).toBe("squad");
    expect(byId.get("app.prod")?.inputs["owner"]).toBe("squad");
    expect(byId.get("app-repo")?.explicitDependsOn).toContain("host-git-org-squad");

    // The team carries the resolved role + member usernames + the repos it is attached to.
    const team = byId.get("host-git-org-squad-team");
    expect(team?.inputs["permission"]).toBe("write");
    expect(team?.inputs["members"]).toEqual(["alice"]);
    expect(team?.inputs["repos"]).toEqual([{ owner: "squad", name: "app" }]);

    // The Komodo user is granted Execute on the app's deployment, and depends on it existing.
    const komodoUser = byId.get("host-deploy-user-alice");
    expect(komodoUser?.inputs["grants"]).toEqual([{ deployment: "app.prod", level: "Execute" }]);
    expect(komodoUser?.explicitDependsOn).toContain("app.prod");
});

test("a team-less app stays admin-owned (identical to the single-admin default)", () => {
    const intent: IntentSet = {
        hosts: [host],
        cloudflare,
        users: [],
        teams: [],
        services: [],
        backings: [],
        apps: [{ id: "app", on: "host", expose: "cf", environments: { prod: { domain: "app.example.com", branch: "main" } } }],
    };

    const repo = emit(intent, assign(intent), "example.com").find((node) => node.id === "app-repo");
    expect(repo?.inputs["owner"]).toBe("intentic");
    expect(repo?.explicitDependsOn).toEqual(["host-git", "cf-git-example-com"]);
});

test("a team referencing an undeclared user throws", () => {
    const intent: IntentSet = {
        hosts: [host],
        cloudflare,
        users: [],
        teams: [{ id: "squad", input: { members: ["ghost"], komodo: "read" } }],
        services: [],
        backings: [],
        apps: [
            {
                id: "app",
                on: "host",
                expose: "cf",
                teams: [{ team: "squad", role: "read" }],
                environments: { prod: { domain: "app.example.com", branch: "main" } },
            },
        ],
    };
    expect(() => emit(intent, assign(intent), "example.com")).toThrow('team "squad" references unknown user "ghost"');
});

test("an app granting an undeclared team throws", () => {
    const intent: IntentSet = {
        hosts: [host],
        cloudflare,
        users: [],
        teams: [],
        services: [],
        backings: [],
        apps: [
            {
                id: "app",
                on: "host",
                expose: "cf",
                teams: [{ team: "ghost", role: "read" }],
                environments: { prod: { domain: "app.example.com", branch: "main" } },
            },
        ],
    };
    expect(() => emit(intent, assign(intent), "example.com")).toThrow('app "app" grants unknown team "ghost"');
});

test("the cloudflare node carries only token + discovered zone, and the tunnel reads the account from it via a ref", () => {
    const intent: IntentSet = {
        hosts: [host],
        cloudflare,
        users: [],
        teams: [],
        services: [],
        backings: [],
        apps: [{ id: "app", on: "host", expose: "cf", environments: { prod: { domain: "app.example.com", branch: "main" } } }],
    };

    const nodes = emit(intent, assign(intent), "example.com");
    expect(nodes.find((node) => node.id === "cf")?.inputs).toEqual({ apiToken: env("CLOUDFLARE_API_TOKEN"), zone: "example.com" });
    // accountId is resolved by the cloudflare provider and read by the tunnel through a ref, never authored.
    expect(nodes.find((node) => node.id === "host-tunnel")?.inputs["accountId"]).toEqual(makeRef("cf", "accountId"));
});

// A minimal one-app intent reused by the guarded-update threading tests.
const oneApp: IntentSet["apps"][number] = {
    id: "app",
    on: "host",
    expose: "cf",
    environments: { production: { domain: "app.example.com", branch: "main" } },
};

test("a guarded host with a backup threads guardRepo + resticImage onto forgejo + komodo", () => {
    const intent: IntentSet = {
        hosts: [{ id: "host", input: { ...host.input, updatePolicy: "guarded" } }],
        cloudflare,
        backup: { id: "backups", input: { repo: "s3:s3.example.com/bucket", password: env("RESTIC_PASSWORD") } },
        users: [],
        teams: [],
        services: [],
        backings: [],
        apps: [oneApp],
    };
    const nodes = emit(intent, assign(intent), "example.com");
    for (const id of ["host-git", "host-deploy"]) {
        const node = nodes.find((n) => n.id === id);
        expect(node?.inputs["guardRepo"], id).toBe("s3:s3.example.com/bucket");
        expect(typeof node?.inputs["resticImage"], id).toBe("string");
    }
    expect(nodes.some((n) => n.id === "host-backup")).toBe(true);
});

test("a pinned host (default) leaves the guard inputs off even when a backup is declared", () => {
    const intent: IntentSet = {
        hosts: [host],
        cloudflare,
        backup: { id: "backups", input: { repo: "s3:s3.example.com/bucket", password: env("RESTIC_PASSWORD") } },
        users: [],
        teams: [],
        services: [],
        backings: [],
        apps: [oneApp],
    };
    const nodes = emit(intent, assign(intent), "example.com");
    expect(nodes.find((n) => n.id === "host-git")?.inputs["guardRepo"]).toBeUndefined();
});

test("a guarded host WITHOUT a declared backup leaves the guard inputs off (nowhere to snapshot)", () => {
    const intent: IntentSet = {
        hosts: [{ id: "host", input: { ...host.input, updatePolicy: "guarded" } }],
        cloudflare,
        users: [],
        teams: [],
        services: [],
        backings: [],
        apps: [oneApp],
    };
    const nodes = emit(intent, assign(intent), "example.com");
    expect(nodes.find((n) => n.id === "host-git")?.inputs["guardRepo"]).toBeUndefined();
});
