import { expect, test } from "vitest";
import { createDevServer, type Spawner, type SpawnHandle } from "./dev-server.js";

// A spawner that records the launch and lets the test trigger the process's exit.
const recordingSpawner = () => {
    const calls: { command: string; args: string[]; cwd: string }[] = [];
    let exit: (() => void) | undefined;
    let killed = 0;
    const spawner: Spawner = (command, args, cwd) => {
        calls.push({ command, args: [...args], cwd });
        const handle: SpawnHandle = {
            kill: () => {
                killed += 1;
            },
            onExit: (callback) => {
                exit = callback;
            },
        };
        return handle;
    };
    return { spawner, calls, kill: () => killed, triggerExit: () => exit?.() };
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
