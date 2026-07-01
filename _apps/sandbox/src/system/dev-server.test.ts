import { expect, test } from "vitest";
import { createDevServer, type DevExit, type Spawner, type SpawnHandle } from "./dev-server.js";

// A spawner that records the launch and lets the test drive the process's output + exit.
const recordingSpawner = () => {
    const calls: { command: string; args: string[]; cwd: string }[] = [];
    let exit: ((exit: DevExit) => void) | undefined;
    let data: ((chunk: string) => void) | undefined;
    let killed = 0;
    const spawner: Spawner = (command, args, cwd) => {
        calls.push({ command, args: [...args], cwd });
        const handle: SpawnHandle = {
            kill: () => {
                killed += 1;
            },
            onData: (callback) => {
                data = callback;
            },
            onExit: (callback) => {
                exit = callback;
            },
        };
        return handle;
    };
    return {
        spawner,
        calls,
        kill: () => killed,
        emit: (chunk: string) => data?.(chunk),
        triggerExit: (value: DevExit = {}) => exit?.(value),
    };
};

test("start launches the command in the repo and status reports running + health", async () => {
    const spawn = recordingSpawner();
    const dev = createDevServer(spawn.spawner, async () => true);
    dev.start({ command: ["pnpm", "dev"], cwd: "/work/app", port: 5173 });
    expect(spawn.calls).toEqual([{ command: "pnpm", args: ["dev"], cwd: "/work/app" }]);
    expect(await dev.status()).toEqual({ running: true, port: 5173, healthy: true });
});

test("an unreachable dev server is running but not healthy", async () => {
    const spawn = recordingSpawner();
    const dev = createDevServer(spawn.spawner, async () => false);
    dev.start({ command: ["pnpm", "dev"], cwd: "/work/app", port: 5173 });
    expect(await dev.status()).toEqual({ running: true, port: 5173, healthy: false });
});

test("a second start is ignored while one is running (one dev server per project)", async () => {
    const spawn = recordingSpawner();
    const dev = createDevServer(spawn.spawner, async () => true);
    dev.start({ command: ["pnpm", "dev"], cwd: "/work/app", port: 5173 });
    dev.start({ command: ["pnpm", "dev"], cwd: "/work/app", port: 5173 });
    expect(spawn.calls).toHaveLength(1);
});

test("stop kills the process and status goes not-running", async () => {
    const spawn = recordingSpawner();
    const dev = createDevServer(spawn.spawner, async () => true);
    dev.start({ command: ["pnpm", "dev"], cwd: "/work/app", port: 5173 });
    dev.stop();
    expect(spawn.kill()).toBe(1);
    expect(await dev.status()).toEqual({ running: false, healthy: false });
});

test("the process exiting on its own clears running state", async () => {
    const spawn = recordingSpawner();
    const dev = createDevServer(spawn.spawner, async () => true);
    dev.start({ command: ["pnpm", "dev"], cwd: "/work/app", port: 5173 });
    spawn.triggerExit();
    expect(await dev.status()).toEqual({ running: false, healthy: false });
});

test("an empty command is rejected", () => {
    const dev = createDevServer(recordingSpawner().spawner, async () => true);
    expect(() => dev.start({ command: [], cwd: "/work/app", port: 5173 })).toThrow("dev server command is empty");
});

// Regression: a non-existent dev command (pnpm absent / app not set up) emits ChildProcess 'error'. The real
// spawner must not let that crash the daemon — it logs and clears running state instead.
test("a failed spawn does not crash the daemon and clears running state", async () => {
    const dev = createDevServer();
    expect(() => dev.start({ command: ["intentic-no-such-binary"], cwd: process.cwd(), port: 5173 })).not.toThrow();
    // The 'error' event fires asynchronously; give it a tick to land before checking the cleared state.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await dev.status()).toEqual({ running: false, healthy: false });
});

test("logs capture the dev output and how it last exited (the 'code: not found' failure is now visible)", () => {
    const spawn = recordingSpawner();
    const dev = createDevServer(spawn.spawner, async () => true);
    dev.start({ command: ["pnpm", "dev"], cwd: "/work/app", port: 5173 });
    spawn.emit("$ code ./_libs/vscode\n");
    spawn.emit("sh: 1: code: not found\n");
    spawn.triggerExit({ code: 127 });
    expect(dev.logs()).toEqual({ output: "$ code ./_libs/vscode\nsh: 1: code: not found\n", lastExit: { code: 127 } });
});

test("the captured output is bounded to the last 64KB", () => {
    const spawn = recordingSpawner();
    const dev = createDevServer(spawn.spawner, async () => true);
    dev.start({ command: ["pnpm", "dev"], cwd: "/work/app", port: 5173 });
    spawn.emit("x".repeat(100_000));
    spawn.emit("TAIL");
    const { output } = dev.logs();
    expect(output.length).toBe(64 * 1024);
    expect(output.endsWith("TAIL")).toBe(true);
});

test("a fresh start clears the previous run's captured logs", () => {
    const spawn = recordingSpawner();
    const dev = createDevServer(spawn.spawner, async () => true);
    dev.start({ command: ["pnpm", "dev"], cwd: "/work/app", port: 5173 });
    spawn.emit("old output\n");
    spawn.triggerExit({ code: 1 });
    dev.start({ command: ["pnpm", "dev"], cwd: "/work/app", port: 5173 });
    expect(dev.logs()).toEqual({ output: "", lastExit: undefined });
});
