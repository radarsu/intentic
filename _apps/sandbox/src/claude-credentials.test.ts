import { expect, test } from "vitest";
import { buildAuthorizeUrl, type ClaudeStore, ensureFreshToken, type StoredAccount } from "./claude-credentials.js";

const memoryStore = (initial?: StoredAccount): ClaudeStore & { current: () => StoredAccount | undefined } => {
    let account = initial;
    return {
        read: async () => account,
        write: async (next) => {
            account = next;
        },
        clear: async () => {
            account = undefined;
        },
        current: () => account,
    };
};

test("buildAuthorizeUrl produces a PKCE authorize URL with the verifier/state to round-trip", () => {
    const challenge = buildAuthorizeUrl();
    const url = new URL(challenge.authorizeUrl);
    expect(url.origin + url.pathname).toBe("https://claude.ai/oauth/authorize");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe(challenge.state);
    expect(challenge.verifier.length).toBeGreaterThan(0);
});

test("ensureFreshToken returns undefined when no account is connected", async () => {
    expect(await ensureFreshToken(memoryStore())).toBeUndefined();
});

test("ensureFreshToken returns the access token while it is still valid", async () => {
    const store = memoryStore({ accessToken: "live", refreshToken: "r", expiresAt: Date.now() + 600_000 });
    let refreshed = false;
    const token = await ensureFreshToken(store, async () => {
        refreshed = true;
        return { accessToken: "new" };
    });
    expect(token).toBe("live");
    expect(refreshed).toBe(false);
});

test("ensureFreshToken refreshes + persists when the token has expired", async () => {
    const store = memoryStore({ accessToken: "stale", refreshToken: "r1", expiresAt: Date.now() - 1000 });
    const token = await ensureFreshToken(store, async (refreshToken) => {
        expect(refreshToken).toBe("r1");
        return { accessToken: "fresh", refreshToken: "r2", expiresAt: Date.now() + 600_000 };
    });
    expect(token).toBe("fresh");
    expect(store.current()).toMatchObject({ accessToken: "fresh", refreshToken: "r2" });
});

test("ensureFreshToken keeps the old refresh token when the refresh response omits one", async () => {
    const store = memoryStore({ accessToken: "stale", refreshToken: "keep", expiresAt: Date.now() - 1000 });
    await ensureFreshToken(store, async () => ({ accessToken: "fresh" }));
    expect(store.current()).toMatchObject({ accessToken: "fresh", refreshToken: "keep" });
});

test("ensureFreshToken returns the (expired) token unchanged when there is no refresh token", async () => {
    const store = memoryStore({ accessToken: "only", expiresAt: Date.now() - 1000 });
    const token = await ensureFreshToken(store, async () => {
        throw new Error("should not refresh without a refresh token");
    });
    expect(token).toBe("only");
});
