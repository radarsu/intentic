import { expect, test } from "vitest";
import { createPreviewProxy, type Forward } from "./proxy-server.js";

const recordingForward = () => {
    const targets: string[] = [];
    const forward: Forward = async (targetUrl) => {
        targets.push(targetUrl);
        return new Response("ok");
    };
    return { forward, targets };
};

test("a preview host is routed to its project's sandbox dev server, preserving path + query", async () => {
    const record = recordingForward();
    const app = createPreviewProxy({ zone: "example.com", devPort: 5173, forward: record.forward });
    const res = await app.request("/dashboard?tab=1", { headers: { host: "acme.preview.example.com" } });
    expect(res.status).toBe(200);
    expect(record.targets).toEqual(["http://intentic-sandbox-acme:5173/dashboard?tab=1"]);
});

test("a non-preview host is not proxied (404)", async () => {
    const record = recordingForward();
    const app = createPreviewProxy({ zone: "example.com", devPort: 5173, forward: record.forward });
    const res = await app.request("/", { headers: { host: "app.example.com" } });
    expect(res.status).toBe(404);
    expect(record.targets).toEqual([]);
});

test("/healthz answers 200 for the readiness probe without proxying", async () => {
    const record = recordingForward();
    const app = createPreviewProxy({ zone: "example.com", devPort: 5173, forward: record.forward });
    const res = await app.request("/healthz", { headers: { host: "anything.preview.example.com" } });
    expect(res.status).toBe(200);
    expect(record.targets).toEqual([]);
});
