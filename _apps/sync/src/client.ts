import type { WorkspaceChange, WorkspaceTree } from "@intentic/sandbox-contract";

// Thin typed wrapper over the daemon's existing workspace endpoints — all plain HTTP, all bearer-authed. Every
// call fetches a fresh-enough ID token via getToken (cached upstream), so a long run never sends an expired one.
export interface SandboxClient {
    tree(): Promise<WorkspaceTree>;
    // Raw bytes of a file; undefined when the daemon 404s (deleted between the event and the pull), and throws
    // on 413 so an oversized file surfaces rather than silently corrupting the mirror.
    raw(path: string): Promise<Uint8Array | undefined>;
    upload(path: string, bytes: Uint8Array): Promise<void>;
    remove(path: string): Promise<void>;
    mkdir(path: string): Promise<void>;
    watch(signal: AbortSignal): AsyncGenerator<WorkspaceChange>;
}

const encodeQuery = (path: string): string => `path=${encodeURIComponent(path)}`;

// Parse an oRPC eventIterator SSE stream into WorkspaceChange objects. One `data: <JSON>\n\n` frame per event
// (same shape the browser's readIntenticLines consumes); malformed frames are skipped.
async function* parseSse(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<WorkspaceChange> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    signal.addEventListener("abort", () => void reader.cancel(), { once: true });
    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            return;
        }
        buffer += decoder.decode(value, { stream: true });
        let separator = buffer.indexOf("\n\n");
        while (separator !== -1) {
            const frame = buffer.slice(0, separator);
            buffer = buffer.slice(separator + 2);
            separator = buffer.indexOf("\n\n");
            const dataLine = frame.split("\n").find((line) => line.startsWith("data:"));
            if (dataLine === undefined) {
                continue;
            }
            const payload = dataLine.slice(5).trim();
            if (payload.length === 0) {
                continue;
            }
            try {
                yield JSON.parse(payload) as WorkspaceChange;
            } catch {
                // Skip a malformed frame rather than tear down the whole stream.
            }
        }
    }
}

export const createSandboxClient = (baseUrl: string, getToken: () => Promise<string>): SandboxClient => {
    const root = baseUrl.replace(/\/$/, "");
    const authHeader = async (): Promise<Record<string, string>> => ({ authorization: `Bearer ${await getToken()}` });

    return {
        tree: async () => {
            const response = await fetch(`${root}/workspace/tree`, { headers: await authHeader() });
            if (!response.ok) {
                throw new Error(`GET /workspace/tree failed: ${response.status}`);
            }
            return (await response.json()) as WorkspaceTree;
        },
        raw: async (path) => {
            const response = await fetch(`${root}/workspace/raw?${encodeQuery(path)}`, { headers: await authHeader() });
            if (response.status === 404) {
                return undefined;
            }
            if (!response.ok) {
                throw new Error(`GET /workspace/raw ${path} failed: ${response.status}`);
            }
            return new Uint8Array(await response.arrayBuffer());
        },
        upload: async (path, bytes) => {
            const response = await fetch(`${root}/workspace/upload?${encodeQuery(path)}`, {
                method: "POST",
                headers: { ...(await authHeader()), "content-type": "application/octet-stream" },
                // TS 5.9 widened Uint8Array to <ArrayBufferLike>, which no longer unifies with BodyInit's
                // ArrayBuffer-backed view — the bytes are a valid body at runtime, so cast past the generic.
                body: bytes as unknown as BodyInit,
            });
            if (!response.ok) {
                throw new Error(`POST /workspace/upload ${path} failed: ${response.status}`);
            }
        },
        remove: async (path) => {
            const response = await fetch(`${root}/workspace/entry`, {
                method: "DELETE",
                headers: { ...(await authHeader()), "content-type": "application/json" },
                body: JSON.stringify({ path }),
            });
            if (!response.ok) {
                throw new Error(`DELETE /workspace/entry ${path} failed: ${response.status}`);
            }
        },
        mkdir: async (path) => {
            const response = await fetch(`${root}/workspace/dir`, {
                method: "POST",
                headers: { ...(await authHeader()), "content-type": "application/json" },
                body: JSON.stringify({ path }),
            });
            if (!response.ok) {
                throw new Error(`POST /workspace/dir ${path} failed: ${response.status}`);
            }
        },
        watch: async function* (signal) {
            const response = await fetch(`${root}/workspace/watch`, { headers: { ...(await authHeader()), accept: "text/event-stream" }, signal });
            if (!response.ok || response.body === null) {
                throw new Error(`GET /workspace/watch failed: ${response.status}`);
            }
            yield* parseSse(response.body, signal);
        },
    };
};
