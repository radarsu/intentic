import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { ORPCError } from "@orpc/server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Services } from "./composition.js";
import { buildOrpcContext } from "./context.js";
import { createRouter } from "./router.js";
import { contentTypeForPath, MAX_RAW_BYTES, resolveWithin } from "./workspace/workspace-files.js";
import { isDeniedWorkspacePath } from "./workspace/workspace-tree.js";

// Only genuine server faults (5xx) are logged; expected ORPCErrors (NOT_FOUND/BAD_REQUEST/…) are the routes'
// normal control flow and would be noise.
const logUnexpectedError = (services: Services, error: unknown): void => {
    if (error instanceof ORPCError && error.code !== "INTERNAL_SERVER_ERROR") {
        return;
    }
    services.logger.error({ err: error instanceof Error ? error : new Error(String(error)) }, "unhandled error");
};

// The HTTP API the browser drives DIRECTLY over the sandbox's own Cloudflare tunnel. When services.auth is set
// the daemon verifies the owner's Google ID token on every route but /health (it owns its own auth). No auth
// only in tests or the host-internal server preview. All routes are oRPC except the plain /health and binary
// /workspace/raw, registered before the catch-all.
export const createApp = (services: Services): Hono => {
    const orpcHandler = new OpenAPIHandler(createRouter(services), {
        interceptors: [
            async (options) => {
                try {
                    return await options.next();
                } catch (error) {
                    logUnexpectedError(services, error);
                    throw error;
                }
            },
        ],
    });

    const app = new Hono();

    if (services.auth !== undefined) {
        const authorize = services.auth.authorize;
        app.use(
            "*",
            cors({
                origin: services.auth.allowOrigin ?? "*",
                allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
                allowHeaders: ["authorization", "content-type", "x-intentic-connect"],
                maxAge: 600,
            }),
        );
        app.use("*", async (c, next) => {
            if (c.req.path === "/health") {
                return next();
            }
            const header = c.req.header("authorization") ?? "";
            const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
            try {
                await authorize(bearer, c.req.header("x-intentic-connect") ?? undefined);
            } catch {
                return c.json({ error: "unauthorized" }, 401);
            }
            return next();
        });
    }

    app.get("/health", (c) => c.json({ ok: true }));

    // Raw bytes for any file under /work, with a Content-Type by extension — the browser previews images/PDF
    // here (the text route utf8-decodes and would corrupt them). Same guards/order as workspace.file: 400 on
    // escape, 404 on denylist/missing, 413 on oversize.
    app.get("/workspace/raw", async (c) => {
        const path = c.req.query("path");
        const target = path === undefined ? undefined : resolveWithin(services.workspace.root, path);
        if (target === undefined) {
            return c.json({ error: "invalid path" }, 400);
        }
        if (isDeniedWorkspacePath(path as string)) {
            return c.json({ error: "not found" }, 404);
        }
        const size = await services.files.size(target);
        if (size === undefined) {
            return c.json({ error: "not found" }, 404);
        }
        if (size > MAX_RAW_BYTES) {
            return c.json({ error: "file too large" }, 413);
        }
        const bytes = await services.files.readBytes(target);
        if (bytes === undefined) {
            return c.json({ error: "not found" }, 404);
        }
        // Wrap in a fresh Uint8Array so the body type is exactly Uint8Array<ArrayBuffer> (a Buffer's backing is
        // ArrayBufferLike, which Hono's body type rejects); bounded by MAX_RAW_BYTES, so the copy is cheap.
        return c.body(new Uint8Array(bytes), 200, { "Content-Type": contentTypeForPath(target), "Content-Length": String(bytes.byteLength) });
    });

    // Everything else flows through the oRPC OpenAPI handler, mounted at the root (its contract paths ARE the
    // daemon's routes). Registered last so /health + /workspace/raw match first.
    app.all("/*", async (c) => {
        const result = await orpcHandler.handle(c.req.raw, { context: buildOrpcContext(c) });
        if (result.matched) {
            return result.response;
        }
        return c.notFound();
    });

    return app;
};
