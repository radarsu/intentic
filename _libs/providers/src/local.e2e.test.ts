import { fileURLToPath } from "node:url";
import type { ApplyOutcome, ReadinessProbe } from "@intentic/engine";
import { apply } from "@intentic/engine";
import { env } from "@intentic/graph";
import { defineStack } from "@intentic/sdk";
import { utils } from "ssh2";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cloudflareApi } from "./cloudflare-api.js";
import { createProviders } from "./providers.js";
import type { SshExecutor } from "./ssh.js";
import { sshExecutor } from "./ssh.js";

// A real, manual, Tier-1 end-to-end run: boot a Docker-in-Docker "host", reach it over SSH, and let the
// engine reconcile the whole derived graph against it — Forgejo, the CI runner, Komodo, the repo/app/
// deploy-hook, plus the real Cloudflare zone/DNS/tunnel. Asserts the graph converges (create) and is
// idempotent (a second apply is all-noop). Gated behind INTENTIC_E2E because it needs a privileged Docker
// daemon and live Cloudflare credentials, so default `pnpm test` / CI skip it entirely.
//
// Required env: INTENTIC_E2E=1, CLOUDFLARE_API_TOKEN (Tunnel+DNS+Zone scopes), CLOUDFLARE_ACCOUNT_ID,
// CLOUDFLARE_ZONE (a throwaway zone you own), FORGEJO_ADMIN_PASSWORD, KOMODO_ADMIN_PASSWORD,
// KOMODO_WEBHOOK_SECRET. The host SSH key is generated per-run; HOST_SSH_KEY is overridden in-process.
const enabled = process.env["INTENTIC_E2E"] === "1" || process.env["INTENTIC_E2E"] === "true";

const required = (key: string): string => {
    const value = process.env[key];
    if (value === undefined || value === "") {
        throw new Error(`local e2e requires env var ${key}`);
    }
    return value;
};

describe.skipIf(!enabled)("local SSH+Docker end-to-end (manual, real Cloudflare)", () => {
    const hostContext = fileURLToPath(new URL("../../../test/host", import.meta.url));
    let host: StartedTestContainer;
    let privateKey: string;
    let first: ApplyOutcome | undefined;
    let zone: string;
    let accountId: string;
    let apiToken: string;

    // The host + Cloudflare are authored inventory. address/user/accountId/zone are literals (resolved at
    // call time from the DinD container + the throwaway zone); only the SSH key is an env secret. The engine
    // reaches the DinD host on its mapped SSH port via the port-injecting executor (see mappedSsh).
    const buildGraph = () =>
        defineStack((i) => {
            const h = i.have.host("host", { address: host.getHost(), user: "root", sshKey: env("HOST_SSH_KEY") });
            const cf = i.have.cloudflare("cf", { accountId, apiToken: env("CLOUDFLARE_API_TOKEN"), zone });
            i.want.app("my-app", {
                on: h,
                expose: cf,
                environments: { staging: { domain: `staging.${zone}`, branch: "main", env: {} } },
            });
        });

    // The graph's host carries no port (default 22), but the DinD host is reached on a random mapped port —
    // inject it into every SSH connection the providers open.
    const mappedSsh: SshExecutor = {
        connect: (target) => sshExecutor.connect({ ...target, port: host.getMappedPort(22) }),
    };

    beforeAll(async () => {
        zone = required("CLOUDFLARE_ZONE");
        accountId = required("CLOUDFLARE_ACCOUNT_ID");
        apiToken = required("CLOUDFLARE_API_TOKEN");
        required("FORGEJO_ADMIN_PASSWORD");
        required("KOMODO_ADMIN_PASSWORD");
        required("KOMODO_WEBHOOK_SECRET");

        const keys = utils.generateKeyPairSync("ed25519");
        privateKey = keys.private;

        const image = await GenericContainer.fromDockerfile(hostContext).build();
        host = await image
            .withPrivilegedMode(true)
            .withEnvironment({ DOCKER_TLS_CERTDIR: "" })
            .withExposedPorts(22)
            .withCopyContentToContainer([{ content: keys.public, target: "/root/.ssh/authorized_keys", mode: 0o600 }])
            .withWaitStrategy(Wait.forListeningPorts())
            .withStartupTimeout(180_000)
            .start();
    }, 240_000);

    afterAll(async () => {
        // Purge the live Cloudflare resources this run created — the engine has no destroy path.
        if (first !== undefined) {
            const tunnelId = first.outputs["host-tunnel"]?.["tunnelId"];
            const zoneId = first.outputs["cf"]?.["zoneId"];
            if (typeof tunnelId === "string") {
                await cloudflareApi
                    .deleteTunnel({ accountId, apiToken, tunnelId })
                    .catch((error) => console.warn(`tunnel cleanup: ${String(error)}`));
            }
            if (typeof zoneId === "string") {
                for (const name of [`git.${zone}`, `komodo.${zone}`, `staging.${zone}`]) {
                    const record = await cloudflareApi.findDnsRecord({ apiToken, zoneId, name }).catch(() => undefined);
                    if (record !== undefined) {
                        await cloudflareApi
                            .deleteDnsRecord({ apiToken, zoneId, recordId: record.id })
                            .catch((error) => console.warn(`dns cleanup ${name}: ${String(error)}`));
                    }
                }
            }
        }
        await host?.stop();
    }, 120_000);

    // Probe readiness FROM THE HOST over SSH: the host trivially reaches its own services on the internal
    // ip, sidestepping the runner's inability to route to the DinD container's network. Deployment ports
    // (>= 20000) are short-circuited since Tier 1 builds no app.
    const sshProbe: ReadinessProbe = async (url) => {
        if (Number(new URL(url).port) >= 20000) {
            return true;
        }
        const session = await sshExecutor.connect({ address: host.getHost(), port: host.getMappedPort(22), user: "root", privateKey });
        try {
            return (await session.exec(`wget -q -O /dev/null ${url}`)).code === 0;
        } catch {
            return false;
        } finally {
            await session.dispose();
        }
    };

    it("creates the whole stack over SSH, then is idempotent", async () => {
        const providers = createProviders({ ssh: mappedSsh });
        const config = {
            providers,
            env: {
                ...process.env,
                HOST_SSH_KEY: privateKey,
            },
            probe: sshProbe,
            log: (message: string) => console.log(message),
        };

        first = await apply(buildGraph(), config);
        const actions = new Map(first.steps.map((step) => [step.id, step.action]));
        expect(actions.get("host")).toBe("noop");
        for (const [id, action] of actions) {
            if (id !== "host") {
                expect(action, `expected ${id} to be created`).toBe("create");
            }
        }
        expect(first.orphans).toEqual([]);

        // The services actually came up on the host.
        const session = await sshExecutor.connect({ address: host.getHost(), port: host.getMappedPort(22), user: "root", privateKey });
        const running = (await session.exec("docker ps --format '{{.Names}}'")).stdout;
        await session.dispose();
        expect(running).toContain("intentic-forgejo");
        expect(running).toContain("intentic-forgejo-runner");
        expect(running).toContain("intentic-komodo-core");

        // The real idempotency proof — and the real test of the deployment config-diff.
        const second = await apply(buildGraph(), config);
        expect(second.steps.every((step) => step.action === "noop")).toBe(true);
    }, 600_000);
});
