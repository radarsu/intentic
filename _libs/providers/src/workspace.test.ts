import { expect, test } from "vitest";
import type { SshExecutor, SshResult, SshSession } from "./ssh.js";
import { createWorkspaceRunnerProvider } from "./workspace.js";

const res = (stdout: string, code = 0): SshResult => ({ stdout, stderr: "", code });

const IMAGE = "ghcr.io/radarsu/intentic-runner:0.1.0";
const SANDBOX_IMAGE = "ghcr.io/radarsu/intentic-sandbox:0.1.0";

const fakeSsh = (opts: { running?: boolean; image?: string; runFails?: boolean } = {}): { executor: SshExecutor; commands: string[] } => {
    const commands: string[] = [];
    const session: SshSession = {
        exec: async (command) => {
            commands.push(command);
            if (command.includes("docker inspect")) {
                return res(opts.image ?? IMAGE);
            }
            if (command.includes("docker ps")) {
                return res(opts.running ? "intentic-runner" : "");
            }
            if (command.includes("docker run")) {
                return res("id", opts.runFails ? 1 : 0);
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
    id: "workspace",
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
    domain: "*.preview.example.com",
    zone: "example.com",
    previewPort: 8088,
    network: "intentic-workspace",
    image: IMAGE,
    sandboxImage: SANDBOX_IMAGE,
};

test("read returns undefined when the host is unreachable over SSH", async () => {
    expect(await createWorkspaceRunnerProvider(unreachable).read(inputs, ctx())).toBeUndefined();
});

test("read returns undefined when the runner container is not running", async () => {
    expect(await createWorkspaceRunnerProvider(fakeSsh({ running: false }).executor).read(inputs, ctx())).toBeUndefined();
});

test("read returns the preview/health/base outputs + observed image when running", async () => {
    expect(await createWorkspaceRunnerProvider(fakeSsh({ running: true }).executor).read(inputs, ctx())).toEqual({
        outputs: {
            internalUrl: "http://10.0.0.5:8088",
            healthUrl: "http://10.0.0.5:8088/healthz",
            previewBase: "preview.example.com",
        },
        detail: { image: IMAGE },
    });
});

test("diff is noop when the running image matches the pin, update when it differs", () => {
    const provider = createWorkspaceRunnerProvider(fakeSsh().executor);
    expect(provider.diff(inputs, { outputs: {}, detail: { image: IMAGE } })).toEqual({ action: "noop" });
    expect(provider.diff(inputs, { outputs: {}, detail: { image: "ghcr.io/radarsu/intentic-runner:0.0.9" } }).action).toBe("update");
});

test("apply ensures the network, then runs the runner with the docker socket, published port, and env", async () => {
    const ssh = fakeSsh();
    const outputs = await createWorkspaceRunnerProvider(ssh.executor).apply(inputs, undefined, ctx());
    expect(outputs).toEqual({
        internalUrl: "http://10.0.0.5:8088",
        healthUrl: "http://10.0.0.5:8088/healthz",
        previewBase: "preview.example.com",
    });
    expect(ssh.commands.some((c) => c.includes("docker network") && c.includes("intentic-workspace"))).toBe(true);
    expect(
        ssh.commands.some(
            (c) =>
                c.includes("docker run") &&
                c.includes("-v /var/run/docker.sock:/var/run/docker.sock") &&
                c.includes("-p 8088:8088") &&
                c.includes("--network intentic-workspace") &&
                c.includes(`-e SANDBOX_IMAGE=${SANDBOX_IMAGE}`) &&
                c.includes("intentic.id=workspace") &&
                c.includes(IMAGE),
        ),
    ).toBe(true);
});

test("apply throws when the docker run fails", async () => {
    await expect(createWorkspaceRunnerProvider(fakeSsh({ runFails: true }).executor).apply(inputs, undefined, ctx())).rejects.toThrow(
        "failed to start workspace runner",
    );
});
