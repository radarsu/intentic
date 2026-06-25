import { expect, test } from "vitest";
import { createKomodoProvider } from "./komodo.js";
import type { SshExecutor, SshResult, SshSession } from "./ssh.js";

const res = (stdout: string, code = 0): SshResult => ({ stdout, stderr: "", code });

// Drives the komodo provider entirely over SSH: docker ps reports the core container, the /api/health
// wget reports liveness, and docker compose up can be made to fail.
const fakeSsh = (opts: { running?: boolean; upFails?: boolean; healthy?: boolean } = {}): { executor: SshExecutor; commands: string[] } => {
    const commands: string[] = [];
    const session: SshSession = {
        exec: async (command) => {
            commands.push(command);
            if (command.includes("docker ps")) {
                return res(opts.running ? "intentic-komodo-core" : "");
            }
            if (command.includes("wget")) {
                return res("", opts.healthy ? 0 : 1);
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
    adminUser: "intentic",
    adminPassword: "pw",
    gitAccount: "intentic",
    gitToken: "gtok-456",
    registry: "localhost:3000",
    packagesToken: "ptok-789",
};

test("read returns undefined when the host is unreachable over SSH", async () => {
    expect(await createKomodoProvider(unreachable).read(inputs, ctx())).toBeUndefined();
});

test("read returns undefined when the core container is not running", async () => {
    expect(await createKomodoProvider(fakeSsh({ running: false }).executor).read(inputs, ctx())).toBeUndefined();
});

test("read returns undefined when core is not yet healthy", async () => {
    const provider = createKomodoProvider(fakeSsh({ running: true, healthy: false }).executor);
    expect(await provider.read(inputs, ctx())).toBeUndefined();
});

test("read returns the deterministic url/internalUrl (no passkey) when running and healthy", async () => {
    const provider = createKomodoProvider(fakeSsh({ running: true, healthy: true }).executor);
    expect(await provider.read(inputs, ctx())).toEqual({ outputs: { url: "https://komodo.example.com", internalUrl: "http://10.0.0.5:9120" } });
});

test("diff is always noop", () => {
    expect(createKomodoProvider(fakeSsh().executor).diff(inputs, { outputs: {} })).toEqual({ action: "noop" });
});

test("apply writes compose + a once-guarded env, brings the stack up, waits for health, and returns outputs", async () => {
    const ssh = fakeSsh({ healthy: true });
    const result = await createKomodoProvider(ssh.executor).apply(inputs, undefined, ctx());
    expect(result).toEqual({ url: "https://komodo.example.com", internalUrl: "http://10.0.0.5:9120" });
    expect(ssh.commands.some((c) => c.includes("cat > /opt/intentic/komodo/compose.yaml"))).toBe(true);
    // The git-provider account is registered against Forgejo's INTERNAL authority (derived from forgejoUrl),
    // over plain http, so Komodo clones host-locally rather than chasing the unresolvable public name.
    expect(
        ssh.commands.some(
            (c) =>
                c.includes("cat > /opt/intentic/komodo/config.toml") &&
                c.includes('domain = "10.0.0.5:3000"') &&
                c.includes("https = false") &&
                c.includes('token = "gtok-456"'),
        ),
    ).toBe(true);
    // The docker-registry account lets Komodo pull the private app images CI pushes to the Forgejo registry.
    expect(
        ssh.commands.some(
            (c) =>
                c.includes("cat > /opt/intentic/komodo/config.toml") && c.includes('domain = "localhost:3000"') && c.includes('token = "ptok-789"'),
        ),
    ).toBe(true);
    // The resource poll interval is baked into the once-guarded .env so auto_update can roll out new images.
    expect(ssh.commands.some((c) => c.includes("test -f /opt/intentic/komodo/.env") && c.includes("KOMODO_RESOURCE_POLL_INTERVAL=OneMinute"))).toBe(
        true,
    );
    expect(ssh.commands.some((c) => c.includes("docker compose -p komodo") && c.includes("up -d"))).toBe(true);
});

test("apply throws when docker compose up exits non-zero", async () => {
    const ssh = fakeSsh({ upFails: true });
    await expect(createKomodoProvider(ssh.executor).apply(inputs, undefined, ctx())).rejects.toThrow(/failed to bring up komodo/);
});

test("apply propagates an SSH connection failure", async () => {
    await expect(createKomodoProvider(unreachable).apply(inputs, undefined, ctx())).rejects.toThrow("ECONNREFUSED");
});

test("malformed inputs are rejected", async () => {
    await expect(createKomodoProvider(fakeSsh().executor).read({ ...inputs, registry: 5 }, ctx())).rejects.toThrow(/komodo inputs malformed/);
});
