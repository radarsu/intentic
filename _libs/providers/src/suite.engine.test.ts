import { defineStack } from "@puristic/deploy-core";
import { apply } from "@puristic/deploy-engine";
import { env } from "@puristic/deploy-protocol";
import { expect, test } from "vitest";

import { createAppProvider } from "./app.js";
import { createCfRouteProvider } from "./cf-route.js";
import { createCloudflareProvider } from "./cloudflare.js";
import type { CloudflareApi, IngressRule } from "./cloudflare-api.js";
import { createDeployHookProvider } from "./deploy-hook.js";
import { createDeploymentProvider } from "./deployment.js";
import { createForgejoProvider } from "./forgejo.js";
import type { ForgejoApi, ForgejoHook, ForgejoRepo } from "./forgejo-api.js";
import { createForgejoNotifyProvider } from "./forgejo-notify.js";
import { createForgejoRunnerProvider } from "./forgejo-runner.js";
import { createHostProvider } from "./host.js";
import { createKomodoProvider } from "./komodo.js";
import type { AlerterConfig, KomodoApi } from "./komodo-api.js";
import { createKomodoNotifyProvider } from "./komodo-notify.js";
import { createRepoProvider } from "./repo.js";
import type { SshExecutor, SshResult } from "./ssh.js";
import { createTunnelProvider } from "./tunnel.js";

// A stateful host shared by host/forgejo/forgejo-runner/komodo/tunnel: Docker-ready, default route ->
// 10.0.0.5, and it remembers which containers have been started so a second apply reads them as running.
const fakeSsh = (): SshExecutor => {
    const started = new Set<string>();
    let tokenPersisted = false;
    const ok = (stdout = "", code = 0): SshResult => ({ stdout, stderr: "", code });
    return {
        connect: async () => ({
            exec: async (command): Promise<SshResult> => {
                if (command.includes("docker version")) return ok("24.0.0");
                if (command.includes("ip -4 -o route")) return ok("10.0.0.5\n");
                if (command.includes("generate-runner-token")) {
                    tokenPersisted = true;
                    return ok("rtok");
                }
                const ps = /docker ps --filter "name=\^([^$]+)\$"/.exec(command);
                if (ps?.[1] !== undefined) return ok(started.has(ps[1]) ? ps[1] : "");
                const run = /docker run .*--name (\S+)/.exec(command);
                if (run?.[1] !== undefined) {
                    started.add(run[1]);
                    return ok("cid");
                }
                if (command.includes("docker compose") && command.includes("up -d")) {
                    started.add("puristic-komodo-core");
                    return ok("up");
                }
                if (command.includes("wget -q --spider")) return ok("", started.has("puristic-forgejo") ? 0 : 1);
                if (command.includes("cat /data/.runner")) return ok(started.has("puristic-forgejo-runner") ? "https://git.example.com" : "");
                if (command.includes("runner-token")) return ok(tokenPersisted ? "rtok" : "");
                return ok();
            },
            dispose: async () => {},
        }),
    };
};

const fakeCloudflare = (): CloudflareApi => {
    const tunnels = new Map<string, string>();
    const records = new Map<string, { id: string; content: string }>();
    let ingress: IngressRule[] | undefined;
    let seq = 0;
    return {
        getZone: async () => ({ id: "zone-123" }),
        findTunnel: async ({ name }) => {
            const id = tunnels.get(name);
            return id === undefined ? undefined : { id };
        },
        createTunnel: async ({ name }) => {
            const id = `tunnel-${seq++}`;
            tunnels.set(name, id);
            return { id };
        },
        getTunnelToken: async () => "connector-token",
        getTunnelIngress: async () => ingress,
        putTunnelIngress: async ({ ingress: next }) => {
            ingress = [...next];
        },
        findDnsRecord: async ({ name }) => records.get(name),
        createDnsRecord: async ({ name, content }) => {
            records.set(name, { id: `rec-${seq++}`, content });
        },
        updateDnsRecord: async ({ name, content, recordId }) => {
            records.set(name, { id: recordId, content });
        },
    };
};

const fakeForgejoApi = (): ForgejoApi => {
    const repos = new Map<string, ForgejoRepo>();
    const hooks = new Map<string, ForgejoHook[]>();
    let seq = 0;
    return {
        findRepo: async ({ name }) => repos.get(name),
        createRepo: async ({ name }) => {
            const repo = { cloneUrl: `https://git.example.com/admin/${name}.git`, sshUrl: `git@git.example.com:admin/${name}.git` };
            repos.set(name, repo);
            return repo;
        },
        listHooks: async ({ name }) => hooks.get(name) ?? [],
        createHook: async ({ name, type, config, events }) => {
            const list = hooks.get(name) ?? [];
            list.push({ id: seq++, type, config, events, active: true });
            hooks.set(name, list);
        },
        updateHook: async ({ name, id, config, events }) => {
            hooks.set(
                name,
                (hooks.get(name) ?? []).map((hook) => (hook.id === id ? { ...hook, config, events } : hook)),
            );
        },
    };
};

const fakeKomodoApi = (): KomodoApi => {
    const builds = new Map<string, string>();
    const deployments = new Map<string, { id: string; state: string }>();
    const alerters = new Map<string, { id: string; config: AlerterConfig }>();
    let seq = 0;
    return {
        health: async () => true,
        login: async () => "jwt",
        listBuilds: async () => [...builds].map(([name, id]) => ({ id, name })),
        createBuild: async ({ name }) => {
            builds.set(name, `b-${seq++}`);
        },
        updateBuild: async () => {},
        listDeployments: async () => [...deployments].map(([name, value]) => ({ id: value.id, name, state: value.state })),
        createDeployment: async ({ name }) => {
            deployments.set(name, { id: `d-${seq++}`, state: "Running" });
        },
        updateDeployment: async () => {},
        deploy: async ({ deployment }) => {
            const value = deployments.get(deployment);
            if (value !== undefined) {
                deployments.set(deployment, { ...value, state: "Running" });
            }
        },
        listAlerters: async () => [...alerters].map(([name, value]) => ({ id: value.id, name })),
        getAlerter: async ({ id }) => {
            for (const value of alerters.values()) {
                if (value.id === id) {
                    return value.config;
                }
            }
            throw new Error(`no alerter ${id}`);
        },
        createAlerter: async ({ name, config }) => {
            alerters.set(name, { id: `a-${seq++}`, config });
        },
        updateAlerter: async ({ id, config }) => {
            for (const [name, value] of alerters) {
                if (value.id === id) {
                    alerters.set(name, { id, config });
                }
            }
        },
    };
};

const fullEnv = {
    HOST_SSH_KEY: "k",
    CLOUDFLARE_API_TOKEN: "k",
    FORGEJO_ADMIN_PASSWORD: "k",
    KOMODO_ADMIN_PASSWORD: "k",
    KOMODO_WEBHOOK_SECRET: "k",
    DISCORD_WEBHOOK: "https://discord.test/wh",
};

const buildGraph = () =>
    defineStack((i) => {
        const host = i.have.host("host", { address: "203.0.113.10", user: "deploy", sshKey: env("HOST_SSH_KEY") });
        const cf = i.have.cloudflare("cf", { accountId: "acc_123", apiToken: env("CLOUDFLARE_API_TOKEN"), zone: "example.com" });
        i.want.app("my-app", {
            on: host,
            expose: cf,
            notify: { discord: env("DISCORD_WEBHOOK") },
            environments: { production: { domain: "app.example.com", branch: "main" } },
        });
    });

const realProviders = () => {
    const cloudflare = fakeCloudflare();
    const ssh = fakeSsh();
    const forgejo = fakeForgejoApi();
    const komodo = fakeKomodoApi();
    return {
        host: createHostProvider(ssh),
        cloudflare: createCloudflareProvider(cloudflare),
        "cf-route": createCfRouteProvider(cloudflare),
        tunnel: createTunnelProvider(cloudflare, ssh),
        forgejo: createForgejoProvider(ssh),
        "forgejo-runner": createForgejoRunnerProvider(ssh),
        komodo: createKomodoProvider(komodo, ssh),
        repo: createRepoProvider(forgejo),
        app: createAppProvider(komodo),
        deployment: createDeploymentProvider(komodo),
        "forgejo-notify": createForgejoNotifyProvider(forgejo),
        "komodo-notify": createKomodoNotifyProvider(komodo),
        "deploy-hook": createDeployHookProvider(forgejo),
    };
};

const base = { env: fullEnv, probe: async () => true, log: () => {} };

test("the full provider suite reconciles a notify-enabled app end-to-end, then is idempotent", async () => {
    const graph = buildGraph();
    const providers = realProviders();

    const first = await apply(graph, { ...base, providers });
    // Owned inventory (host, cf) reads as existing; every derived platform/app/notify node is created.
    const byId = new Map(first.steps.map((step) => [step.id, step.action]));
    expect(byId.get("host")).toBe("noop");
    expect(byId.get("cf")).toBe("noop");
    for (const [id, action] of byId) {
        if (id !== "host" && id !== "cf") {
            expect(action, `expected ${id} to be created`).toBe("create");
        }
    }
    // The whole derived suite is present: git/CI, deploy, repo, app, deployment, routes, notify, deploy-hook.
    expect([...byId.keys()].sort()).toEqual(
        [
            "host",
            "cf",
            "host-git",
            "host-git-runner",
            "host-deploy",
            "cf-git-example-com",
            "cf-komodo-example-com",
            "my-app-repo",
            "my-app",
            "my-app.production",
            "cf-app-example-com",
            "my-app.production-deploy-hook",
            "my-app-repo-notify",
            "my-app-notify",
            "host-tunnel",
        ].sort(),
    );
    // Komodo's output is url/internalUrl only — the stale v1 passkey was dropped.
    expect(first.outputs["host-deploy"]).toEqual({ url: "https://komodo.example.com", internalUrl: "http://10.0.0.5:9120" });
    expect(first.orphans).toEqual([]);

    // Same fakes (same world) => everything is found, healthy, and converged => all noop.
    const second = await apply(graph, { ...base, providers });
    expect(second.steps.every((step) => step.action === "noop")).toBe(true);
});
