import { expect, test } from "vitest";
import type { SshExecutor, SshResult, SshSession } from "../core/ssh.js";
import { createWorkspaceProvider } from "./workspace.js";

const res = (stdout: string, code = 0): SshResult => ({ stdout, stderr: "", code });

const IMAGE = "ghcr.io/radarsu/intentic-sandbox:0.1.0";
const CONTAINER = "intentic-sandbox-workspace";

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
                return res(opts.running ? CONTAINER : "");
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
    devPort: 5173,
    daemonPort: 8787,
    devCommand: "pnpm dev",
    network: "intentic-workspace",
    image: IMAGE,
};

const OUTPUTS = {
    internalUrl: "http://10.0.0.5:8787",
    healthUrl: "http://10.0.0.5:8787/health",
    previewBase: "preview.example.com",
};

test("read returns undefined when the host is unreachable over SSH", async () => {
    expect(await createWorkspaceProvider(unreachable).read(inputs, ctx())).toBeUndefined();
});

test("read returns undefined when the sandbox container is not running", async () => {
    expect(await createWorkspaceProvider(fakeSsh({ running: false }).executor).read(inputs, ctx())).toBeUndefined();
});

test("read returns the daemon/health/base outputs + observed image and tools digest when running", async () => {
    expect(await createWorkspaceProvider(fakeSsh({ running: true, tools: "deadbeef" }).executor).read(inputs, ctx())).toEqual({
        outputs: OUTPUTS,
        detail: { image: IMAGE, tools: "deadbeef" },
    });
});

test("diff is noop when the running image matches the pin, update when it differs", () => {
    const provider = createWorkspaceProvider(fakeSsh().executor);
    expect(provider.diff(inputs, { outputs: {}, detail: { image: IMAGE, tools: "" } })).toEqual({ action: "noop" });
    expect(provider.diff(inputs, { outputs: {}, detail: { image: "ghcr.io/radarsu/intentic-sandbox:0.0.9", tools: "" } }).action).toBe("update");
});

test("apply forwards the agent tools as base64 INTENTIC_AGENT_TOOLS + stamps the tools digest label", async () => {
    const ssh = fakeSsh();
    await createWorkspaceProvider(ssh.executor).apply({ ...inputs, tools: [TOOL] }, undefined, ctx());
    const run = ssh.commands.find((c) => c.includes("docker run")) ?? "";
    const encoded = /-e INTENTIC_AGENT_TOOLS=(\S+)/.exec(run)?.[1];
    expect(encoded).toBeDefined();
    // The value round-trips: base64 → JSON → the resolved tools the agent connects to.
    expect(JSON.parse(Buffer.from(encoded as string, "base64").toString("utf8"))).toEqual([TOOL]);
    expect(/--label intentic\.tools=\S+/.test(run)).toBe(true);
});

test("apply omits the tools env when no tools are wired (preview-only sandboxes stay lean)", async () => {
    const ssh = fakeSsh();
    await createWorkspaceProvider(ssh.executor).apply(inputs, undefined, ctx());
    expect(ssh.commands.some((c) => c.includes("INTENTIC_AGENT_TOOLS"))).toBe(false);
});

test("diff updates when the agent tools change (digest drift), and is noop against the digest apply stamped", async () => {
    const ssh = fakeSsh();
    const provider = createWorkspaceProvider(ssh.executor);
    const withTools = { ...inputs, tools: [TOOL] };
    // A stale/empty tools label against a tools-bearing spec must recreate so the new tools take effect.
    expect(provider.diff(withTools, { outputs: {}, detail: { image: IMAGE, tools: "" } }).action).toBe("update");
    // The digest apply stamps on the container is exactly what diff treats as a noop (no needless recreate).
    await provider.apply(withTools, undefined, ctx());
    const digest = /--label intentic\.tools=(\S+)/.exec(ssh.commands.find((c) => c.includes("docker run")) ?? "")?.[1];
    expect(digest).toBeDefined();
    expect(provider.diff(withTools, { outputs: {}, detail: { image: IMAGE, tools: digest as string } })).toEqual({ action: "noop" });
});

test("apply ensures the network, then runs the sandbox UNPRIVILEGED with internalIp-bound ports + the env", async () => {
    const ssh = fakeSsh();
    const outputs = await createWorkspaceProvider(ssh.executor).apply(inputs, undefined, ctx());
    expect(outputs).toEqual(OUTPUTS);
    expect(ssh.commands.some((c) => c.includes("docker network") && c.includes("intentic-workspace"))).toBe(true);
    const run = ssh.commands.find((c) => c.includes("docker run")) ?? "";
    // Unprivileged: the sandbox IS the workspace now — no docker-socket mount, no root.
    expect(run).not.toContain("--user root");
    expect(run).not.toContain("/var/run/docker.sock");
    // Both ports bind the host's internal ip (the tunnel reaches them; the public interface does not).
    expect(run).toContain("-p 10.0.0.5:5173:5173");
    expect(run).toContain("-p 10.0.0.5:8787:8787");
    expect(run).toContain("-v intentic-workspace-workspace:/work");
    expect(run).toContain("--network intentic-workspace");
    expect(run).toContain("--add-host host.docker.internal:host-gateway");
    expect(run).toContain("-e SANDBOX_PORT=8787");
    expect(run).toContain("-e DEV_PORT=5173");
    expect(run).toContain("-e DEV_COMMAND='pnpm dev'");
    expect(run).toContain(`-e SANDBOX_NAME=${CONTAINER}`);
    expect(run).toContain(`-e SANDBOX_IMAGE=${IMAGE}`);
    expect(run).toContain("intentic.id=workspace");
    expect(run).toContain(IMAGE);
});

test("apply throws when the docker run fails", async () => {
    await expect(createWorkspaceProvider(fakeSsh({ runFails: true }).executor).apply(inputs, undefined, ctx())).rejects.toThrow(
        "failed to start workspace sandbox",
    );
});

test("apply sets ANTHROPIC_BASE_URL only when agentBaseUrl is provided", async () => {
    const without = fakeSsh();
    await createWorkspaceProvider(without.executor).apply(inputs, undefined, ctx());
    expect(without.commands.some((c) => c.includes("ANTHROPIC_BASE_URL"))).toBe(false);

    const withBase = fakeSsh();
    await createWorkspaceProvider(withBase.executor).apply({ ...inputs, agentBaseUrl: "http://gateway.internal:4000" }, undefined, ctx());
    expect(withBase.commands.some((c) => c.includes("docker run") && c.includes("-e ANTHROPIC_BASE_URL=http://gateway.internal:4000"))).toBe(true);
});
