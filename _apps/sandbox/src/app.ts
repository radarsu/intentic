import { type EnrollHostInput, EnrollHostInputSchema } from "@intentic/sandbox-contract";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { ORPCError } from "@orpc/server";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import { tokenEquals } from "./auth/auth.js";
import type { Services } from "./composition.js";
import { buildOrpcContext } from "./context.js";
import { enrollHost } from "./inventory/enroll-host.js";
import { createRouter } from "./router.js";
import {
    clearAuthorizedKeys,
    consumePairing,
    enrollAuthorizedKey,
    isKeyEnrolled,
    isValidAuthorizedKey,
    isValidPairing,
    mintPairing,
    syncSshHostname,
} from "./system/sync.js";
import { createTerminalRoute } from "./system/terminal.js";
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

// Extract the bearer token from an Authorization header (empty string when absent/malformed).
const bearerFrom = (header: string | undefined): string => (header?.startsWith("Bearer ") ? header.slice(7) : "");

// The lowercased email in a member-management request body, or undefined when absent/malformed.
const memberEmail = async (c: Context): Promise<string | undefined> => {
    const body = (await c.req.json().catch(() => undefined)) as { email?: unknown } | undefined;
    return typeof body?.email === "string" ? body.email.toLowerCase() : undefined;
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
            // /system/terminal is a WebSocket upgrade: the browser can't set an Authorization header on it, so
            // the terminal route authorizes the token from the query string itself (see createTerminalRoute).
            // /system/authorized-key is redeemed by the desktop-sync agent with a one-time pairing token instead
            // of a bearer; the POST handler checks that token itself and the DELETE handler re-checks the owner.
            if (c.req.path === "/health" || c.req.path === "/system/terminal" || c.req.path === "/enroll" || c.req.path === "/system/authorized-key") {
                return next();
            }
            try {
                await authorize(bearerFrom(c.req.header("authorization")), c.req.header("x-intentic-connect") ?? undefined);
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

    // Write raw bytes to any file under /work — the drag-drop upload AND the editor's text save both post here
    // (bytes / utf8 body are the same to persist), so writes stay off oRPC like the raw read above. Parent dirs
    // are auto-created, so a nested dropped-folder path materializes its tree. Same guards/order as the read:
    // 400 on escape, 404 on the secret/`.git` denylist, 413 on oversize (checked from Content-Length first, then
    // the actual body length in case the header lied).
    app.post("/workspace/upload", async (c) => {
        const path = c.req.query("path");
        const target = path === undefined ? undefined : resolveWithin(services.workspace.root, path);
        if (target === undefined) {
            return c.json({ error: "invalid path" }, 400);
        }
        if (isDeniedWorkspacePath(path as string)) {
            return c.json({ error: "not found" }, 404);
        }
        const declared = Number(c.req.header("content-length"));
        if (Number.isFinite(declared) && declared > MAX_RAW_BYTES) {
            return c.json({ error: "file too large" }, 413);
        }
        const bytes = new Uint8Array(await c.req.arrayBuffer());
        if (bytes.byteLength > MAX_RAW_BYTES) {
            return c.json({ error: "file too large" }, 413);
        }
        await services.files.write(target, bytes);
        return c.json({ ok: true });
    });

    // Interactive PTY over a WebSocket. Paired with the `ws` server passed to serve() in main.ts (node-server's
    // upgradeWebSocket drives it); registered before the oRPC catch-all so the upgrade matches here.
    app.get("/system/terminal", createTerminalRoute(services));

    // Deploy-target enrollment from the connect-host script (curl, not a browser): authenticated by the connect
    // token alone (exempt from the bearer middleware above), so it self-registers a host without a Google login.
    // Loopback mode (no services.auth) accepts any caller, like every other route.
    app.post("/enroll", async (c) => {
        if (services.auth !== undefined && !tokenEquals(c.req.header("x-intentic-connect") ?? "", services.config.connectToken)) {
            return c.json({ error: "unauthorized" }, 401);
        }
        let input: EnrollHostInput;
        try {
            input = EnrollHostInputSchema.parse(await c.req.json());
        } catch {
            return c.json({ error: "invalid enrollment body" }, 400);
        }
        try {
            await enrollHost(services, input);
        } catch (error) {
            if (error instanceof ORPCError && error.code === "PRECONDITION_FAILED") {
                return c.json({ error: error.message }, 412);
            }
            throw error;
        }
        return c.json({ ok: true });
    });

    // Owner-only management of the sandbox's shared-access list — the emails the auth check above admits besides
    // the owner. The owner's browser calls these when inviting/removing collaborators; the platform mirrors the
    // grants for discovery, but THIS list is the enforced one. Loopback mode (no auth) skips the owner gate, like
    // every other route. The bearer middleware already ran (caller is at least a member); the owner gate narrows it.
    const ensureOwner = async (c: Context): Promise<boolean> => {
        if (services.auth === undefined) {
            return true;
        }
        try {
            await services.auth.authorizeOwner(bearerFrom(c.req.header("authorization")));
            return true;
        } catch {
            return false;
        }
    };
    app.get("/members", async (c) => {
        if (!(await ensureOwner(c))) {
            return c.json({ error: "unauthorized" }, 401);
        }
        return c.json({ emails: await services.members.list() });
    });
    app.post("/members", async (c) => {
        if (!(await ensureOwner(c))) {
            return c.json({ error: "unauthorized" }, 401);
        }
        const email = await memberEmail(c);
        if (email === undefined) {
            return c.json({ error: "email required" }, 400);
        }
        await services.members.add(email);
        return c.json({ emails: await services.members.list() });
    });
    app.delete("/members", async (c) => {
        if (!(await ensureOwner(c))) {
            return c.json({ error: "unauthorized" }, 401);
        }
        const email = await memberEmail(c);
        if (email === undefined) {
            return c.json({ error: "email required" }, 400);
        }
        await services.members.remove(email);
        return c.json({ emails: await services.members.list() });
    });

    // Local-sync (Mutagen) enrollment. The owner mints a short-lived pairing token in the browser (owner-gated,
    // like /members); the desktop agent redeems it once here to enroll its SSH key — so the agent needs no OAuth,
    // and trust still roots in the owner's Google identity that minted the token. These sit before the oRPC
    // catch-all, like /members and /workspace/raw.
    app.post("/system/sync/pair", async (c) => {
        if (!(await ensureOwner(c))) {
            return c.json({ error: "unauthorized" }, 401);
        }
        return c.json(mintPairing());
    });
    app.post("/system/authorized-key", async (c) => {
        // Authorized either by a valid pairing token (the agent's path) or the owner's Google token (fallback).
        const pair = c.req.header("x-intentic-pair") ?? undefined;
        const viaPair = pair !== undefined && isValidPairing(pair);
        if (!viaPair && !(await ensureOwner(c))) {
            return c.json({ error: "unauthorized" }, 401);
        }
        const body = (await c.req.json().catch(() => undefined)) as { key?: unknown } | undefined;
        const key = typeof body?.key === "string" ? body.key : undefined;
        if (key === undefined || !isValidAuthorizedKey(key)) {
            return c.json({ error: "invalid key" }, 400);
        }
        // The agent needs the tunnel's SSH host to point Mutagen at; without one, sync can't reach this sandbox.
        const sshHostname = syncSshHostname(services.config.connectToken, services.config.zone, services.config.sandbox.publicUrl);
        if (sshHostname === undefined) {
            return c.json({ error: "ssh tunnel not configured" }, 409);
        }
        await enrollAuthorizedKey(key);
        // Burn the pairing token only on success, so a transient failure leaves it usable for a retry.
        if (pair !== undefined) {
            consumePairing(pair);
        }
        return c.json({ ok: true, sshHostname });
    });
    app.get("/system/sync", async (c) => {
        if (!(await ensureOwner(c))) {
            return c.json({ error: "unauthorized" }, 401);
        }
        const sshHostname = syncSshHostname(services.config.connectToken, services.config.zone, services.config.sandbox.publicUrl);
        // Always 200 so the UI can render its "enable" vs "enabled" state; sshHostname is omitted when this
        // sandbox has no SSH tunnel (loopback/preview), which the card treats as "sync unavailable".
        return c.json({ enrolled: await isKeyEnrolled(), ...(sshHostname !== undefined ? { sshHostname } : {}) });
    });
    app.delete("/system/authorized-key", async (c) => {
        if (!(await ensureOwner(c))) {
            return c.json({ error: "unauthorized" }, 401);
        }
        await clearAuthorizedKeys();
        return c.json({ ok: true });
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
