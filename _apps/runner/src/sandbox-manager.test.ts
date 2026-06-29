import { expect, test } from "vitest";
import type { DockerRunner } from "./docker.js";
import { ensureSandbox, removeSandbox, sandboxName } from "./sandbox-manager.js";

// A fake docker that answers `inspect` from a script and records every argv, so lifecycle decisions are
// observable without Docker.
const fakeDocker = (inspect: { running: boolean; image?: string }) => {
    const calls: string[][] = [];
    const docker: DockerRunner = async (args) => {
        calls.push([...args]);
        if (args[0] === "inspect") {
            return inspect.running ? { stdout: `true ${inspect.image ?? ""}\n`, stderr: "", code: 0 } : { stdout: "", stderr: "", code: 1 };
        }
        return { stdout: "", stderr: "", code: 0 };
    };
    return { docker, calls };
};

const spec = {
    project: "acme",
    image: "intentic/sandbox:1",
    network: "intentic-workspace",
    devCommand: "pnpm dev",
    devPort: 5173,
    daemonPort: 8787,
    agentEnv: { ANTHROPIC_API_KEY: "sk-test" },
};

const ran = (calls: string[][]): string[] | undefined => calls.find((call) => call[0] === "run");

test("ensureSandbox creates the container when absent, wiring network, volume, env, and creds", async () => {
    const { docker, calls } = fakeDocker({ running: false });
    const sandbox = await ensureSandbox(spec, docker);

    expect(sandbox).toEqual({ name: "intentic-sandbox-acme", daemonUrl: "http://intentic-sandbox-acme:8787", devPort: 5173 });
    expect(calls).toContainEqual(["network", "inspect", "intentic-workspace"]);
    const run = ran(calls);
    expect(run).toBeDefined();
    const argv = (run ?? []).join(" ");
    expect(argv).toContain("--network intentic-workspace");
    expect(argv).toContain("--add-host host.docker.internal:host-gateway");
    expect(argv).toContain("-v intentic-workspace-acme:/work");
    expect(argv).toContain("-e ANTHROPIC_API_KEY=sk-test");
    expect(argv).toContain("-e SANDBOX_HOST=0.0.0.0");
    expect(argv).toContain("-e DEV_PORT=5173");
    expect(argv).toContain("intentic/sandbox:1");
});

test("ensureSandbox reuses a container already running the desired image (no recreate)", async () => {
    const { docker, calls } = fakeDocker({ running: true, image: "intentic/sandbox:1" });
    await ensureSandbox(spec, docker);
    expect(ran(calls)).toBeUndefined();
    expect(calls.some((call) => call[0] === "rm")).toBe(false);
});

test("ensureSandbox recreates when the running image differs", async () => {
    const { docker, calls } = fakeDocker({ running: true, image: "intentic/sandbox:0" });
    await ensureSandbox(spec, docker);
    expect(calls).toContainEqual(["rm", "-f", "intentic-sandbox-acme"]);
    expect(ran(calls)).toBeDefined();
});

test("removeSandbox force-removes the project container", async () => {
    const { docker, calls } = fakeDocker({ running: true, image: "intentic/sandbox:1" });
    await removeSandbox("acme", docker);
    expect(calls).toEqual([["rm", "-f", sandboxName("acme")]]);
});
