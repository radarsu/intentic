import { type ContainerState, type DockerRunner, inspectContainer } from "./docker.js";
import { ensureSandbox, removeSandbox, type Sandbox, type SandboxSpec, sandboxName } from "./sandbox-manager.js";

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
export type SleepFn = (ms: number) => Promise<void>;

export interface ControllerDeps {
    readonly spec: SandboxSpec;
    readonly docker?: DockerRunner;
    readonly fetch?: FetchFn;
    // Injectable for tests; defaults to a real timer so the daemon-readiness poll backs off without busy-waiting.
    readonly sleep?: SleepFn;
}

// How long ensure waits for the daemon to answer /health after a cold container start, and how often it polls.
const DAEMON_READY_TIMEOUT_MS = 30_000;
const DAEMON_READY_INTERVAL_MS = 250;

// Block until the sandbox daemon answers GET /health, so a relay issued right after ensure doesn't race the
// daemon's bind on a cold start (`docker run` returns when the container is up, but @hono/node-server takes a
// moment to listen). Throws if it never comes up in time — a legible "did not become ready" instead of the
// opaque "fetch failed" the first relay would otherwise surface.
const waitForDaemon = async (fetchFn: FetchFn, daemonUrl: string, sleep: SleepFn): Promise<void> => {
    const deadline = Date.now() + DAEMON_READY_TIMEOUT_MS;
    for (;;) {
        try {
            if ((await fetchFn(`${daemonUrl}/health`)).ok) {
                return;
            }
        } catch {
            // Connection refused while the daemon binds — keep polling until the deadline.
        }
        if (Date.now() >= deadline) {
            throw new Error(`sandbox daemon did not become ready within ${DAEMON_READY_TIMEOUT_MS}ms`);
        }
        await sleep(DAEMON_READY_INTERVAL_MS);
    }
};

// The runner's behavior over its one sandbox: lifecycle (ensure/remove/status via the host docker) and a
// transport-agnostic relay that streams the sandbox daemon's responses line by line. The Phase-3 channel
// drives these from the platform and pumps relay lines back over WS; previews bypass this (the proxy).
export interface Controller {
    readonly ensure: () => Promise<Sandbox>;
    readonly remove: () => Promise<void>;
    readonly status: () => Promise<ContainerState>;
    readonly relay: (path: string, init?: RequestInit) => AsyncGenerator<string>;
}

// Read a fetch Response body as trimmed, non-empty lines (the sandbox daemon emits SSE `data:` frames for
// /agent and /intentic, and single-line JSON for /git) — carries partial lines across chunk boundaries.
async function* bodyLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        buffer += decoder.decode(value, { stream: true });
        let index = buffer.indexOf("\n");
        while (index !== -1) {
            const line = buffer.slice(0, index).trim();
            if (line !== "") {
                yield line;
            }
            buffer = buffer.slice(index + 1);
            index = buffer.indexOf("\n");
        }
    }
    const last = buffer.trim();
    if (last !== "") {
        yield last;
    }
}

export const createController = (deps: ControllerDeps): Controller => {
    const fetchFn = deps.fetch ?? ((url, init) => fetch(url, init));
    const sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const name = sandboxName(deps.spec.project);
    const daemonUrl = `http://${name}:${deps.spec.daemonPort}`;
    return {
        ensure: async () => {
            const sandbox = await ensureSandbox(deps.spec, deps.docker);
            await waitForDaemon(fetchFn, daemonUrl, sleep);
            return sandbox;
        },
        remove: () => removeSandbox(deps.spec.project, deps.docker),
        status: () => inspectContainer(name, deps.docker),
        relay: async function* (path, init) {
            const response = await fetchFn(`${daemonUrl}${path}`, init);
            if (response.body === null) {
                return;
            }
            yield* bodyLines(response.body);
        },
    };
};
