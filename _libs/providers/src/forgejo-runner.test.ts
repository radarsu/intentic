import { expect, test } from "vitest";
import { createForgejoRunnerProvider } from "./forgejo-runner.js";
import type { SshExecutor, SshResult, SshSession } from "./ssh.js";

const res = (stdout: string, code = 0): SshResult => ({ stdout, stderr: "", code });

const fakeSsh = (opts: { running?: boolean; registered?: boolean; runFails?: boolean } = {}): { executor: SshExecutor; commands: string[] } => {
    const commands: string[] = [];
    const session: SshSession = {
        exec: async (command) => {
            commands.push(command);
            if (command.includes("docker ps")) {
                return res(opts.running ? "intentic-forgejo-runner" : "");
            }
            if (command.includes("cat /data/.runner")) {
                return res(opts.registered ? '{"address":"https://git.example.com"}' : "");
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
    id: "host-git-runner",
    output: () => {
        throw new Error("unused");
    },
});

const inputs = { server: "host", address: "203.0.113.10", user: "deploy", sshKey: "key", instanceUrl: "https://git.example.com", token: "tok-123" };

test("read returns undefined when the host is unreachable over SSH", async () => {
    expect(await createForgejoRunnerProvider(unreachable).read(inputs, ctx())).toBeUndefined();
});

test("read returns undefined when the runner container is not running", async () => {
    expect(await createForgejoRunnerProvider(fakeSsh({ running: false }).executor).read(inputs, ctx())).toBeUndefined();
});

test("read returns undefined when the runner is not registered to the desired instance", async () => {
    expect(await createForgejoRunnerProvider(fakeSsh({ running: true, registered: false }).executor).read(inputs, ctx())).toBeUndefined();
});

test("read returns empty outputs when running and registered to the instance", async () => {
    expect(await createForgejoRunnerProvider(fakeSsh({ running: true, registered: true }).executor).read(inputs, ctx())).toEqual({ outputs: {} });
});

test("diff is always noop", () => {
    expect(createForgejoRunnerProvider(fakeSsh().executor).diff(inputs, { outputs: {} })).toEqual({ action: "noop" });
});

test("apply registers against the instance + token and starts the daemon, returning empty outputs", async () => {
    const ssh = fakeSsh();
    expect(await createForgejoRunnerProvider(ssh.executor).apply(inputs, undefined, ctx())).toEqual({});
    expect(
        ssh.commands.some(
            (c) =>
                c.includes("docker run") &&
                c.includes("--instance https://git.example.com") &&
                c.includes("--token tok-123") &&
                c.includes("intentic.id=host-git-runner"),
        ),
    ).toBe(true);
});

test("apply throws when docker run exits non-zero", async () => {
    await expect(createForgejoRunnerProvider(fakeSsh({ runFails: true }).executor).apply(inputs, undefined, ctx())).rejects.toThrow(
        /failed to start forgejo-runner/,
    );
});

test("apply propagates an SSH connection failure", async () => {
    await expect(createForgejoRunnerProvider(unreachable).apply(inputs, undefined, ctx())).rejects.toThrow("ECONNREFUSED");
});

test("malformed inputs are rejected", async () => {
    await expect(createForgejoRunnerProvider(fakeSsh().executor).read({ ...inputs, token: 5 }, ctx())).rejects.toThrow(
        /forgejo-runner inputs malformed/,
    );
});
