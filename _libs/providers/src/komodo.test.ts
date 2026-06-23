import { expect, test } from "vitest";
import { createKomodoProvider } from "./komodo.js";
import type { KomodoApi } from "./komodo-api.js";
import type { SshExecutor, SshResult, SshSession } from "./ssh.js";

const NOT_USED = async (): Promise<never> => {
    throw new Error("unused by the komodo provider");
};
const api = (overrides: Partial<KomodoApi>): KomodoApi => ({
    health: NOT_USED,
    login: NOT_USED,
    listBuilds: NOT_USED,
    createBuild: NOT_USED,
    updateBuild: NOT_USED,
    listDeployments: NOT_USED,
    createDeployment: NOT_USED,
    updateDeployment: NOT_USED,
    deploy: NOT_USED,
    listAlerters: NOT_USED,
    getAlerter: NOT_USED,
    createAlerter: NOT_USED,
    updateAlerter: NOT_USED,
    ...overrides,
});

const res = (stdout: string, code = 0): SshResult => ({ stdout, stderr: "", code });

const fakeSsh = (opts: { running?: boolean; upFails?: boolean } = {}): { executor: SshExecutor; commands: string[] } => {
    const commands: string[] = [];
    const session: SshSession = {
        exec: async (command) => {
            commands.push(command);
            if (command.includes("docker ps")) {
                return res(opts.running ? "puristic-komodo-core" : "");
            }
            if (command.includes("docker compose")) {
                return res("up", opts.upFails ? 1 : 0);
            }
            return res("");
        },
        dispose: async () => {},
    };
    return { executor: { connect: async () => session }, commands };
};

const unreachable: SshExecutor = {
    connect: async () => {
        throw new Error("ECONNREFUSED");
    },
};

const ctx = (log: (message: string) => void = () => {}) => ({
    env: {},
    log,
    id: "host-deploy",
    output: () => {
        throw new Error("unused");
    },
});

const inputs = {
    server: "host",
    address: "203.0.113.10",
    user: "deploy",
    sshKey: "key",
    internalIp: "10.0.0.5",
    domain: "komodo.example.com",
    forgejoUrl: "http://10.0.0.5:3000",
    runnerToken: "tok-123",
    adminUser: "puristic",
    adminPassword: "pw",
    webhookSecret: "whsec",
};

test("read returns undefined when the host is unreachable over SSH", async () => {
    expect(await createKomodoProvider(api({}), unreachable).read(inputs, ctx())).toBeUndefined();
});

test("read returns undefined when the core container is not running", async () => {
    expect(await createKomodoProvider(api({}), fakeSsh({ running: false }).executor).read(inputs, ctx())).toBeUndefined();
});

test("read returns undefined when core is not yet healthy", async () => {
    const provider = createKomodoProvider(api({ health: async () => false }), fakeSsh({ running: true }).executor);
    expect(await provider.read(inputs, ctx())).toBeUndefined();
});

test("read returns the deterministic url/internalUrl (no passkey) when running and healthy", async () => {
    const provider = createKomodoProvider(api({ health: async () => true }), fakeSsh({ running: true }).executor);
    expect(await provider.read(inputs, ctx())).toEqual({ outputs: { url: "https://komodo.example.com", internalUrl: "http://10.0.0.5:9120" } });
});

test("diff is always noop", () => {
    expect(createKomodoProvider(api({}), fakeSsh().executor).diff(inputs, { outputs: {} })).toEqual({ action: "noop" });
});

test("apply writes compose + a once-guarded env, brings the stack up, waits for health, and returns outputs", async () => {
    const ssh = fakeSsh();
    const result = await createKomodoProvider(api({ health: async () => true }), ssh.executor).apply(inputs, undefined, ctx());
    expect(result).toEqual({ url: "https://komodo.example.com", internalUrl: "http://10.0.0.5:9120" });
    expect(ssh.commands.some((c) => c.includes("cat > /opt/puristic/komodo/compose.yaml"))).toBe(true);
    expect(ssh.commands.some((c) => c.includes("test -f /opt/puristic/komodo/.env") && c.includes("KOMODO_WEBHOOK_SECRET=whsec"))).toBe(true);
    expect(ssh.commands.some((c) => c.includes("docker compose -p komodo") && c.includes("up -d"))).toBe(true);
});

test("apply throws when docker compose up exits non-zero", async () => {
    const ssh = fakeSsh({ upFails: true });
    await expect(createKomodoProvider(api({}), ssh.executor).apply(inputs, undefined, ctx())).rejects.toThrow(/failed to bring up komodo/);
});

test("apply propagates an SSH connection failure", async () => {
    await expect(createKomodoProvider(api({}), unreachable).apply(inputs, undefined, ctx())).rejects.toThrow("ECONNREFUSED");
});

test("malformed inputs are rejected", async () => {
    await expect(createKomodoProvider(api({}), fakeSsh().executor).read({ ...inputs, webhookSecret: 5 }, ctx())).rejects.toThrow(
        /komodo inputs malformed/,
    );
});
