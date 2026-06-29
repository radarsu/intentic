import { Hono } from "hono";
import { verifyAgentToken } from "./agent-token.js";
import { agentTarget, previewTarget } from "./preview-proxy.js";

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
    // The sandbox daemon port — the `/__agent` route forwards here (the agent API) instead of the dev server.
    readonly daemonPort: number;
    // The runner's token, used to verify the platform-minted bearer token on `/__agent` requests. When unset
    // (preview-only host), the agent route is disabled.
    readonly runnerToken?: string;
    readonly forward?: Forward;
}

// Requests under this path on a preview host are the browser driving the sandbox agent directly. The prefix
// is stripped before forwarding, so `/__agent/agent` → daemon `/agent`, `/__agent/agent/decision` → `/agent/decision`.
const AGENT_PREFIX = "/__agent";

// CORS for the cross-origin `/__agent` calls (the browser is on the platform web origin, this host is the
// preview domain). Bearer-token auth (no cookies), so a permissive origin is safe.
const corsHeaders: Record<string, string> = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-max-age": "600",
};

// The host-published preview reverse proxy. The wildcard `*.preview.<zone>` tunnel ingress points here; each
// request is routed by Host header to its project's sandbox dev server — except `/__agent*`, which (once the
// bearer token checks out) is forwarded to that sandbox's daemon so the browser can run the agent directly.
export const createPreviewProxy = (config: PreviewProxyConfig): Hono => {
    const forward = config.forward ?? defaultForward;
    const app = new Hono();
    // Liveness for the workspace node's readyWhen probe — the catch-all below 404s non-preview hosts, so the
    // runner needs an explicit 200 to gate on. Registered before the catch-all.
    app.get("/healthz", (c) => c.json({ ok: true }));
    app.all("*", async (c) => {
        const url = new URL(c.req.url);

        if (url.pathname === AGENT_PREFIX || url.pathname.startsWith(`${AGENT_PREFIX}/`)) {
            if (c.req.method === "OPTIONS") {
                return new Response(null, { status: 204, headers: corsHeaders });
            }
            const target = agentTarget(c.req.header("host") ?? "", config.zone, config.daemonPort);
            if (target === undefined || config.runnerToken === undefined || config.runnerToken === "") {
                return c.json({ error: "agent not available for this host" }, 404, corsHeaders);
            }
            const auth = c.req.header("authorization") ?? "";
            const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
            if (token === "" || !verifyAgentToken(token, config.runnerToken)) {
                return c.json({ error: "unauthorized" }, 401, corsHeaders);
            }
            const path = url.pathname.slice(AGENT_PREFIX.length) || "/";
            const response = await forward(`${target}${path}${url.search}`, c.req.raw);
            // Re-emit with CORS so the browser accepts the (streamed) response.
            const headers = new Headers(response.headers);
            for (const [key, value] of Object.entries(corsHeaders)) {
                headers.set(key, value);
            }
            return new Response(response.body, { status: response.status, headers });
        }

        const target = previewTarget(c.req.header("host") ?? "", config.zone, config.devPort);
        if (target === undefined) {
            return c.json({ error: "no preview for this host" }, 404);
        }
        return forward(`${target}${url.pathname}${url.search}`, c.req.raw);
    });
    return app;
};
