import { spawn } from "node:child_process";

export interface DevServerSpec {
    // The watch command split into argv, e.g. ["pnpm", "dev"].
    readonly command: readonly string[];
    readonly cwd: string;
    // The port the dev server listens on; the Cloudflare tunnel maps the `*.preview.<zone>` hostname to it.
    readonly port: number;
}

export interface DevServerStatus {
    readonly running: boolean;
    readonly healthy: boolean;
    readonly port?: number;
}

// How the last dev process ended — surfaced next to the captured output so the UI can say "exited (127)" instead
// of silently showing a dead preview. Both undefined while it's still running / was never started.
export interface DevExit {
    readonly code?: number;
    readonly signal?: string;
}

// The dev command's recent stdout+stderr (a bounded tail) plus how it last ended. This is what makes a failed
// `pnpm dev` (e.g. the `code: not found` that looked like a container crash) visible in-app instead of buried in
// the container log.
export interface DevServerLogs {
    readonly output: string;
    readonly lastExit: DevExit | undefined;
}

// A started process, reduced to what the manager needs — injectable so tests need no real child. onData streams
// the merged stdout+stderr; onExit reports how it ended (also fired on a failed spawn, with both undefined).
export interface SpawnHandle {
    readonly kill: () => void;
    readonly onData: (callback: (chunk: string) => void) => void;
    readonly onExit: (callback: (exit: DevExit) => void) => void;
}
export type Spawner = (command: string, args: readonly string[], cwd: string) => SpawnHandle;
export type HealthProbe = (port: number) => Promise<boolean>;

// Keep only the last slice of output — a watch server left running for hours must not grow unbounded.
const MAX_LOG_CHARS = 64 * 1024;

const defaultSpawn: Spawner = (command, args, cwd) => {
    const child = spawn(command, [...args], { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let onData: ((chunk: string) => void) | undefined;
    // A failed spawn (the dev command isn't installed, or the app repo has no deps yet) emits an 'error' event —
    // with no listener Node rethrows it and kills the daemon. The dev server is auxiliary to the agent/git/claude
    // routes, so log it, feed it to the captured tail, and treat it like an exit instead of crashing the process.
    child.on("error", (error) => {
        const message = `dev server failed to start (${command}): ${error.message}\n`;
        process.stderr.write(message);
        onData?.(message);
    });
    return {
        kill: () => child.kill("SIGTERM"),
        // Tee to the container log (so `docker logs` still shows the dev output) AND to the captured tail.
        onData: (callback) => {
            onData = callback;
            child.stdout?.on("data", (chunk: Buffer) => {
                process.stdout.write(chunk);
                callback(chunk.toString());
            });
            child.stderr?.on("data", (chunk: Buffer) => {
                process.stderr.write(chunk);
                callback(chunk.toString());
            });
        },
        onExit: (callback) => {
            child.on("exit", (code, signal) => callback({ ...(code !== null ? { code } : {}), ...(signal !== null ? { signal } : {}) }));
            child.on("error", () => callback({}));
        },
    };
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
    readonly logs: () => DevServerLogs;
}

// Manages the single per-project watch-mode dev server. One sandbox = one project = one dev server, so a
// second start while running is ignored. The daemon reports status + captured logs; the Cloudflare tunnel fronts
// the port.
export const createDevServer = (spawner: Spawner = defaultSpawn, probe: HealthProbe = defaultProbe): DevServer => {
    let current: { readonly handle: SpawnHandle; readonly port: number } | undefined;
    let output = "";
    let lastExit: DevExit | undefined;
    const append = (chunk: string): void => {
        output += chunk;
        if (output.length > MAX_LOG_CHARS) {
            output = output.slice(output.length - MAX_LOG_CHARS);
        }
    };
    return {
        start: (spec) => {
            if (current !== undefined) {
                return;
            }
            const [command, ...args] = spec.command;
            if (command === undefined) {
                throw new Error("dev server command is empty");
            }
            output = "";
            lastExit = undefined;
            const handle = spawner(command, args, spec.cwd);
            current = { handle, port: spec.port };
            handle.onData(append);
            handle.onExit((exit) => {
                lastExit = exit;
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
        logs: () => ({ output, lastExit }),
    };
};
