import type { Context } from "hono";

// Per-request context handed to every oRPC handler. Auth + CORS run as Hono middleware ahead of the oRPC
// catch-all (the daemon owns its own auth), so handlers need nothing beyond the raw request metadata —
// mirroring the platform/verification-api OrpcContext. The request's AbortSignal reaches streaming handlers
// through oRPC's own `signal` handler option, not this context.
export interface OrpcContext {
    headers: Headers;
    method: string;
    url: string;
}

export const buildOrpcContext = (c: Context): OrpcContext => {
    const url = new URL(c.req.url);
    return { headers: c.req.raw.headers, method: c.req.method, url: url.pathname + url.search };
};
