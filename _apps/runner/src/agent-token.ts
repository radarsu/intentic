import { createHmac, timingSafeEqual } from "node:crypto";

/* Compact bearer token the platform mints and the runner proxy verifies before forwarding a browser request
 * to the sandbox daemon. Format: `<base64url(payload)>.<base64url(HMAC-SHA256(payload, secret))>` where the
 * payload is `{ exp }` (epoch ms). The signing secret is the runner's token (RUNNER_TOKEN), known to both the
 * platform (DB `Runner.token`) and the runner — so no extra secret or JWT dependency is needed. The platform
 * vouches for the user; the runner only checks the signature + expiry. Keep this identical to the platform's
 * `signAgentToken` (intentic-platform/_apps/api/src/agent-token.ts). */

const b64url = (input: Buffer): string => input.toString("base64url");
const sign = (payloadB64: string, secret: string): string => b64url(createHmac("sha256", secret).update(payloadB64).digest());

// Mint a token valid for `ttlMs`. The platform's `signAgentToken` is the source of truth in production; this
// mirror keeps the scheme in one place and lets the proxy tests build valid tokens.
export const signAgentToken = (secret: string, ttlMs: number, now: number = Date.now()): string => {
    const payloadB64 = b64url(Buffer.from(JSON.stringify({ exp: now + ttlMs }), "utf8"));
    return `${payloadB64}.${sign(payloadB64, secret)}`;
};

export const verifyAgentToken = (token: string, secret: string, now: number = Date.now()): boolean => {
    const dot = token.indexOf(".");
    if (dot <= 0) {
        return false;
    }
    const payloadB64 = token.slice(0, dot);
    const expected = sign(payloadB64, secret);
    const got = token.slice(dot + 1);
    // Compare as bytes, length-guarded, so a wrong-length signature can't throw timingSafeEqual.
    const a = Buffer.from(got);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
        return false;
    }
    try {
        const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as { exp?: unknown };
        return typeof payload.exp === "number" && payload.exp > now;
    } catch {
        return false;
    }
};
