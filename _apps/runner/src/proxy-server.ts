import { Hono } from "hono";
import { previewTarget } from "./preview-proxy.js";

// Forwards a proxied request to a resolved sandbox URL. Injectable so the routing is testable without
// network; the default streams the original method/headers/body through `fetch`.
export type Forward = (targetUrl: string, request: Request) => Promise<Response>;

const defaultForward: Forward = (targetUrl, request) =>
    fetch(targetUrl, {
        method: request.method,
        headers: request.headers,
        ...(request.body !== null ? { body: request.body, duplex: "half" } : {}),
        redirect: "manual",
    } as RequestInit);

export interface PreviewProxyConfig {
    readonly zone: string;
    // The dev-server port every sandbox publishes (one sandbox per project ⇒ a single port).
    readonly devPort: number;
    readonly forward?: Forward;
}

// The host-published preview reverse proxy. The wildcard `*.preview.<zone>` tunnel ingress points here; each
// request is routed by Host header to its project's sandbox dev server. A non-preview host gets a 404.
export const createPreviewProxy = (config: PreviewProxyConfig): Hono => {
    const forward = config.forward ?? defaultForward;
    const app = new Hono();
    // Liveness for the workspace node's readyWhen probe — the catch-all below 404s non-preview hosts, so the
    // runner needs an explicit 200 to gate on. Registered before the catch-all.
    app.get("/healthz", (c) => c.json({ ok: true }));
    app.all("*", async (c) => {
        const target = previewTarget(c.req.header("host") ?? "", config.zone, config.devPort);
        if (target === undefined) {
            return c.json({ error: "no preview for this host" }, 404);
        }
        const url = new URL(c.req.url);
        return forward(`${target}${url.pathname}${url.search}`, c.req.raw);
    });
    return app;
};
