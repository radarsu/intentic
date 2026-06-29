import { expect, test } from "vitest";
import type { SshExecutor, SshResult, SshSession } from "./ssh.js";
import { createWorkspaceRunnerProvider } from "./workspace.js";

const res = (stdout: string, code = 0): SshResult => ({ stdout, stderr: "", code });

const IMAGE = "ghcr.io/radarsu/intentic-runner:0.1.0";
const SANDBOX_IMAGE = "ghcr.io/radarsu/intentic-sandbox:0.1.0";

const fakeSsh = (
    opts: { running?: boolean; image?: string; tools?: string; runFails?: boolean } = {},
): { executor: SshExecutor; commands: string[] } => {
    const commands: string[] = [];
    const session: SshSession = {
        exec: async (command) => {
            commands.push(command);
            // Both image + tools-digest reads are `docker inspect`; distinguish by the label template (the
            // run command also carries an `intentic.tools=` label, so this must stay inside the inspect branch).
            if (command.includes("docker inspect")) {
                return res(command.includes("intentic.tools") ? (opts.tools ?? "") : (opts.image ?? IMAGE));
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

// A resolved agent tool as the engine hands it to the provider (token already a concrete string).
const TOOL = { name: "obs", url: "https://signoz.example.com/mcp", token: "tok-mcp" };

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

test("read returns the preview/health/base outputs + observed image and tools digest when running", async () => {
    expect(await createWorkspaceRunnerProvider(fakeSsh({ running: true, tools: "deadbeef" }).executor).read(inputs, ctx())).toEqual({
        outputs: {
            internalUrl: "http://10.0.0.5:8088",
            healthUrl: "http://10.0.0.5:8088/healthz",
            previewBase: "preview.example.com",
        },
        detail: { image: IMAGE, tools: "deadbeef" },
    });
});

test("diff is noop when the running image matches the pin, update when it differs", () => {
    const provider = createWorkspaceRunnerProvider(fakeSsh().executor);
    expect(provider.diff(inputs, { outputs: {}, detail: { image: IMAGE, tools: "" } })).toEqual({ action: "noop" });
    expect(provider.diff(inputs, { outputs: {}, detail: { image: "ghcr.io/radarsu/intentic-runner:0.0.9", tools: "" } }).action).toBe("update");
});

test("apply forwards the agent tools as base64 INTENTIC_AGENT_TOOLS + stamps the tools digest label", async () => {
    const ssh = fakeSsh();
    await createWorkspaceRunnerProvider(ssh.executor).apply({ ...inputs, tools: [TOOL] }, undefined, ctx());
    const run = ssh.commands.find((c) => c.includes("docker run")) ?? "";
    const encoded = /-e INTENTIC_AGENT_TOOLS=(\S+)/.exec(run)?.[1];
    expect(encoded).toBeDefined();
    // The value round-trips: base64 → JSON → the resolved tools the agent connects to.
    expect(JSON.parse(Buffer.from(encoded as string, "base64").toString("utf8"))).toEqual([TOOL]);
    expect(/--label intentic\.tools=\S+/.test(run)).toBe(true);
});

test("apply omits the tools env when no tools are wired (preview-only runners stay lean)", async () => {
    const ssh = fakeSsh();
    await createWorkspaceRunnerProvider(ssh.executor).apply(inputs, undefined, ctx());
    expect(ssh.commands.some((c) => c.includes("INTENTIC_AGENT_TOOLS"))).toBe(false);
});

test("diff updates when the agent tools change (digest drift), and is noop against the digest apply stamped", async () => {
    const ssh = fakeSsh();
    const provider = createWorkspaceRunnerProvider(ssh.executor);
    const withTools = { ...inputs, tools: [TOOL] };
    // A stale/empty tools label against a tools-bearing spec must recreate so the new tools take effect.
    expect(provider.diff(withTools, { outputs: {}, detail: { image: IMAGE, tools: "" } }).action).toBe("update");
    // The digest apply stamps on the container is exactly what diff treats as a noop (no needless recreate).
    await provider.apply(withTools, undefined, ctx());
    const digest = /--label intentic\.tools=(\S+)/.exec(ssh.commands.find((c) => c.includes("docker run")) ?? "")?.[1];
    expect(digest).toBeDefined();
    expect(provider.diff(withTools, { outputs: {}, detail: { image: IMAGE, tools: digest as string } })).toEqual({ action: "noop" });
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

test("apply passes the control-plane env only when platformUrl + runnerToken are set", async () => {
    const without = fakeSsh();
    await createWorkspaceRunnerProvider(without.executor).apply(inputs, undefined, ctx());
    expect(without.commands.some((c) => c.includes("PLATFORM_URL"))).toBe(false);

    const withChannel = fakeSsh();
    await createWorkspaceRunnerProvider(withChannel.executor).apply(
        { ...inputs, platformUrl: "wss://platform.example/runner/gateway", runnerToken: "tok-123" },
        undefined,
        ctx(),
    );
    expect(
        withChannel.commands.some(
            (c) =>
                c.includes("docker run") &&
                c.includes("-e PLATFORM_URL=wss://platform.example/runner/gateway") &&
                c.includes("-e RUNNER_TOKEN=tok-123"),
        ),
    ).toBe(true);
});
