import { expect, test } from "vitest";
import { createSignozProvider } from "./signoz.js";
import type { SshExecutor, SshResult, SshSession } from "./ssh.js";

const res = (stdout: string, code = 0): SshResult => ({ stdout, stderr: "", code });

// Drives the signoz provider entirely over SSH: docker ps reports the UI container, the wget reports
// liveness, docker compose up can be made to fail, and the register curl reports an HTTP status.
const fakeSsh = (
    opts: { running?: boolean; upFails?: boolean; healthy?: boolean; register?: string } = {},
): { executor: SshExecutor; commands: string[] } => {
    const commands: string[] = [];
    const session: SshSession = {
        exec: async (command) => {
            commands.push(command);
            if (command.includes("docker ps")) {
                return res(opts.running ? "intentic-signoz" : "");
            }
            if (command.includes("wget")) {
                return res("", opts.healthy ? 0 : 1);
            }
            if (command.includes("docker compose")) {
                return res("up", opts.upFails ? 1 : 0);
            }
            if (command.includes("curl")) {
                return res(opts.register ?? "200");
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
    id: "obs",
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
    domain: "signoz.example.com",
    adminUser: "intentic@example.com",
    adminPassword: "pw",
};

const outputs = { url: "https://signoz.example.com", internalUrl: "http://10.0.0.5:8080", otlpEndpoint: "http://10.0.0.5:4318" };

test("read returns undefined when the host is unreachable over SSH", async () => {
    expect(await createSignozProvider(unreachable).read(inputs, ctx())).toBeUndefined();
});

test("read returns undefined when the UI container is not running", async () => {
    expect(await createSignozProvider(fakeSsh({ running: false }).executor).read(inputs, ctx())).toBeUndefined();
});

test("read returns undefined when the UI is not yet healthy", async () => {
    expect(await createSignozProvider(fakeSsh({ running: true, healthy: false }).executor).read(inputs, ctx())).toBeUndefined();
});

test("read returns the deterministic url/internalUrl/otlpEndpoint when running and healthy", async () => {
    const provider = createSignozProvider(fakeSsh({ running: true, healthy: true }).executor);
    expect(await provider.read(inputs, ctx())).toEqual({ outputs });
});

test("diff is always noop", () => {
    expect(createSignozProvider(fakeSsh().executor).diff(inputs, { outputs: {} })).toEqual({ action: "noop" });
});

test("apply writes the compose + config files + a once-guarded env, brings the stack up, waits for health, seeds the admin, and returns outputs", async () => {
    const ssh = fakeSsh({ healthy: true });
    const result = await createSignozProvider(ssh.executor).apply(inputs, undefined, ctx());
    expect(result).toEqual(outputs);
    expect(ssh.commands.some((c) => c.includes("cat > /opt/intentic/signoz/compose.yaml"))).toBe(true);
    expect(ssh.commands.some((c) => c.includes("cat > /opt/intentic/signoz/otel-collector-config.yaml"))).toBe(true);
    expect(ssh.commands.some((c) => c.includes("cat > /opt/intentic/signoz/clickhouse-cluster.xml"))).toBe(true);
    expect(ssh.commands.some((c) => c.includes("test -f /opt/intentic/signoz/.env") && c.includes("COMPOSE_SIGNOZ_IMAGE_TAG="))).toBe(true);
    expect(ssh.commands.some((c) => c.includes("docker compose -p signoz") && c.includes("up -d"))).toBe(true);
    // The admin is seeded against the register API with the resolved email + password.
    expect(ssh.commands.some((c) => c.includes("/api/v1/register") && c.includes("intentic@example.com") && c.includes('"password":"pw"'))).toBe(
        true,
    );
});

test("apply tolerates an already-seeded admin (register returns non-200), logging instead of failing", async () => {
    const logs: string[] = [];
    const ssh = fakeSsh({ healthy: true, register: "409" });
    await createSignozProvider(ssh.executor).apply(
        inputs,
        undefined,
        ctx((m) => logs.push(m)),
    );
    expect(logs.some((m) => m.includes("register returned 409"))).toBe(true);
});

test("apply throws when docker compose up exits non-zero", async () => {
    const ssh = fakeSsh({ upFails: true });
    await expect(createSignozProvider(ssh.executor).apply(inputs, undefined, ctx())).rejects.toThrow(/failed to bring up signoz/);
});

test("apply propagates an SSH connection failure", async () => {
    await expect(createSignozProvider(unreachable).apply(inputs, undefined, ctx())).rejects.toThrow("ECONNREFUSED");
});

test("malformed inputs are rejected", async () => {
    await expect(createSignozProvider(fakeSsh().executor).read({ ...inputs, internalIp: 5 }, ctx())).rejects.toThrow(/signoz inputs malformed/);
});
