import { expect, test } from "vitest";
import { signAgentToken } from "./agent-token.js";
import { createPreviewProxy, type Forward } from "./proxy-server.js";

const recordingForward = () => {
    const targets: string[] = [];
    const forward: Forward = async (targetUrl) => {
        targets.push(targetUrl);
        return new Response("ok");
    };
    return { forward, targets };
};

const config = (forward: Forward) => ({ zone: "example.com", devPort: 5173, daemonPort: 8787, runnerToken: "runner-secret", forward });

test("a preview host is routed to its project's sandbox dev server, preserving path + query", async () => {
    const record = recordingForward();
    const app = createPreviewProxy(config(record.forward));
    const res = await app.request("/dashboard?tab=1", { headers: { host: "acme.preview.example.com" } });
    expect(res.status).toBe(200);
    expect(record.targets).toEqual(["http://intentic-sandbox-acme:5173/dashboard?tab=1"]);
});

test("a non-preview host is not proxied (404)", async () => {
    const record = recordingForward();
    const app = createPreviewProxy(config(record.forward));
    const res = await app.request("/", { headers: { host: "app.example.com" } });
    expect(res.status).toBe(404);
    expect(record.targets).toEqual([]);
});

test("/healthz answers 200 for the readiness probe without proxying", async () => {
    const record = recordingForward();
    const app = createPreviewProxy(config(record.forward));
    const res = await app.request("/healthz", { headers: { host: "anything.preview.example.com" } });
    expect(res.status).toBe(200);
    expect(record.targets).toEqual([]);
});

test("/__agent with a valid token forwards to the sandbox daemon with the prefix stripped", async () => {
    const record = recordingForward();
    const app = createPreviewProxy(config(record.forward));
    const token = signAgentToken("runner-secret", 60_000);
    const res = await app.request("/__agent/agent", {
        method: "POST",
        headers: { host: "acme.preview.example.com", authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ prompt: "hi" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(record.targets).toEqual(["http://intentic-sandbox-acme:8787/agent"]);
});

test("/__agent without a valid token is rejected (401) and never forwarded", async () => {
    const record = recordingForward();
    const app = createPreviewProxy(config(record.forward));
    const missing = await app.request("/__agent/agent", { method: "POST", headers: { host: "acme.preview.example.com" } });
    expect(missing.status).toBe(401);
    const bad = await app.request("/__agent/agent", {
        method: "POST",
        headers: { host: "acme.preview.example.com", authorization: "Bearer not.a.valid.token" },
    });
    expect(bad.status).toBe(401);
    const expired = await app.request("/__agent/agent", {
        method: "POST",
        headers: { host: "acme.preview.example.com", authorization: `Bearer ${signAgentToken("runner-secret", -1000)}` },
    });
    expect(expired.status).toBe(401);
    expect(record.targets).toEqual([]);
});

test("an OPTIONS preflight on /__agent returns CORS headers without auth", async () => {
    const record = recordingForward();
    const app = createPreviewProxy(config(record.forward));
    const res = await app.request("/__agent/agent", { method: "OPTIONS", headers: { host: "acme.preview.example.com" } });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(record.targets).toEqual([]);
});
