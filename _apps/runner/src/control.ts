import { type ContainerState, type DockerRunner, inspectContainer } from "./docker.js";
import { ensureSandbox, removeSandbox, type Sandbox, type SandboxSpec, sandboxName } from "./sandbox-manager.js";

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface ControllerDeps {
    readonly spec: SandboxSpec;
    readonly docker?: DockerRunner;
    readonly fetch?: FetchFn;
}

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
    const name = sandboxName(deps.spec.project);
    const daemonUrl = `http://${name}:${deps.spec.daemonPort}`;
    return {
        ensure: () => ensureSandbox(deps.spec, deps.docker),
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
