import { expect, test } from "vitest";
import { createController, type FetchFn } from "./control.js";
import type { DockerRunner } from "./docker.js";

const spec = {
    project: "acme",
    image: "intentic/sandbox:1",
    network: "intentic-workspace",
    devCommand: "pnpm dev",
    devPort: 5173,
    daemonPort: 8787,
    agentEnv: {},
};

const recordingDocker = (inspect: { running: boolean; image?: string }) => {
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

test("ensure brings the sandbox up and returns how to reach its daemon", async () => {
    const { docker, calls } = recordingDocker({ running: false });
    const sandbox = await createController({ spec, docker }).ensure();
    expect(sandbox.daemonUrl).toBe("http://intentic-sandbox-acme:8787");
    expect(calls.some((call) => call[0] === "run")).toBe(true);
});

test("status reports the container state", async () => {
    const { docker } = recordingDocker({ running: true, image: "intentic/sandbox:1" });
    expect(await createController({ spec, docker }).status()).toEqual({ running: true, image: "intentic/sandbox:1" });
});

test("relay fetches the sandbox daemon and yields its response as trimmed lines", async () => {
    const seen: string[] = [];
    const fetchFn: FetchFn = async (url) => {
        seen.push(url);
        return new Response('data: {"kind":"delta"}\n\ndata: {"kind":"done"}\n');
    };
    const lines: string[] = [];
    for await (const line of createController({ spec, fetch: fetchFn }).relay("/agent", { method: "POST" })) {
        lines.push(line);
    }
    expect(seen).toEqual(["http://intentic-sandbox-acme:8787/agent"]);
    expect(lines).toEqual(['data: {"kind":"delta"}', 'data: {"kind":"done"}']);
});
