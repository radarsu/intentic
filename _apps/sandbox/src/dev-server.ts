import { spawn } from "node:child_process";

export interface DevServerSpec {
    // The watch command split into argv, e.g. ["pnpm", "dev"].
    readonly command: readonly string[];
    readonly cwd: string;
    // The port the dev server listens on; the runner's reverse proxy maps a preview hostname to it.
    readonly port: number;
}

export interface DevServerStatus {
    readonly running: boolean;
    readonly healthy: boolean;
    readonly port?: number;
}

// A started process, reduced to what the manager needs — injectable so tests need no real child.
export interface SpawnHandle {
    readonly kill: () => void;
    readonly onExit: (callback: () => void) => void;
}
export type Spawner = (command: string, args: readonly string[], cwd: string) => SpawnHandle;
export type HealthProbe = (port: number) => Promise<boolean>;

const defaultSpawn: Spawner = (command, args, cwd) => {
    const child = spawn(command, [...args], { cwd, env: process.env, stdio: "inherit" });
    return { kill: () => child.kill("SIGTERM"), onExit: (callback) => child.on("exit", () => callback()) };
};

// Healthy means the dev server answered at all (even a 404) — only a refused/failed connection is unhealthy,
// since a watch server is "up" before it has routes.
const defaultProbe: HealthProbe = async (port) => {
    try {
        await fetch(`http://127.0.0.1:${port}/`);
        return true;
    } catch {
        return false;
    }
};

export interface DevServer {
    readonly start: (spec: DevServerSpec) => void;
    readonly stop: () => void;
    readonly status: () => Promise<DevServerStatus>;
}

// Manages the single per-project watch-mode dev server. One sandbox = one project = one dev server, so a
// second start while running is ignored. The daemon reports status; the runner's proxy fronts the port.
export const createDevServer = (spawner: Spawner = defaultSpawn, probe: HealthProbe = defaultProbe): DevServer => {
    let current: { readonly handle: SpawnHandle; readonly port: number } | undefined;
    return {
        start: (spec) => {
            if (current !== undefined) {
                return;
            }
            const [command, ...args] = spec.command;
            if (command === undefined) {
                throw new Error("dev server command is empty");
            }
            const handle = spawner(command, args, spec.cwd);
            current = { handle, port: spec.port };
            handle.onExit(() => {
                current = undefined;
            });
        },
        stop: () => {
            if (current !== undefined) {
                current.handle.kill();
                current = undefined;
            }
        },
        status: async () => {
            if (current === undefined) {
                return { running: false, healthy: false };
            }
            return { running: true, port: current.port, healthy: await probe(current.port) };
        },
    };
};
