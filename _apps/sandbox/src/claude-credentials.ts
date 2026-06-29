import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/* Claude subscription OAuth (PKCE) against the public Claude Code client — the sandbox OWNS these credentials
 * (the platform no longer holds them): the user authorizes once, the sandbox stores the tokens beside the
 * workspace and refreshes them on demand. The constants are unofficial/undocumented (they mirror what
 * `claude setup-token` uses) and may change. The redirect URI is Anthropic's hosted code-callback page (we
 * can't register our own), so the flow is: open the authorize URL → authorize → Anthropic shows `code#state`
 * → the caller pastes it back → we exchange it. The platform UI relays this handshake but stores nothing. */
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const SCOPES = "org:create_api_key user:profile user:inference";

// Refresh a little before the real expiry so an in-flight turn doesn't race the deadline.
const EXPIRY_SKEW_MS = 60_000;

const base64url = (buffer: Buffer): string => buffer.toString("base64url");

export interface AuthorizeChallenge {
    readonly authorizeUrl: string;
    readonly verifier: string;
    readonly state: string;
}

// Build the authorize URL plus the PKCE verifier/state the caller round-trips back to `exchangeCode`. The
// verifier is the client-held PKCE secret; handing it to the browser is expected for a public client and
// means no server-side pending-auth store is needed.
export const buildAuthorizeUrl = (): AuthorizeChallenge => {
    const verifier = base64url(randomBytes(32));
    const challenge = base64url(createHash("sha256").update(verifier).digest());
    const state = base64url(randomBytes(32));
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("code", "true");
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("scope", SCOPES);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);
    return { authorizeUrl: url.toString(), verifier, state };
};

// The persisted account: tokens plus an epoch-ms expiry (JSON-friendly). Stored beside the workspace, outside
// the three repos so it is never committed.
export interface StoredAccount {
    readonly accessToken: string;
    readonly refreshToken?: string;
    readonly expiresAt?: number;
    readonly scope?: string;
}

interface TokenResponse {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
}

const requestTokens = async (body: Record<string, string>): Promise<StoredAccount> => {
    const response = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`Claude token request failed (${response.status}). ${detail}`.trim());
    }
    const json = (await response.json()) as TokenResponse;
    return {
        accessToken: json.access_token,
        ...(json.refresh_token !== undefined ? { refreshToken: json.refresh_token } : {}),
        ...(typeof json.expires_in === "number" ? { expiresAt: Date.now() + json.expires_in * 1000 } : {}),
        ...(json.scope !== undefined ? { scope: json.scope } : {}),
    };
};

// Anthropic's manual flow shows the value as `code#state`; accept either that or a bare code.
export const exchangeCode = (pastedCode: string, verifier: string, fallbackState: string): Promise<StoredAccount> => {
    const [code = "", state = fallbackState] = pastedCode.trim().split("#");
    return requestTokens({
        grant_type: "authorization_code",
        code,
        state,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
    });
};

export type RefreshFn = (refreshToken: string) => Promise<StoredAccount>;

const refreshTokens: RefreshFn = (refreshToken) =>
    requestTokens({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLIENT_ID });

// The credential store, injected so the daemon's tests need no filesystem.
export interface ClaudeStore {
    readonly read: () => Promise<StoredAccount | undefined>;
    readonly write: (account: StoredAccount) => Promise<void>;
    readonly clear: () => Promise<void>;
}

// A JSON file store, used in production at <workspace>/.intentic/claude.json (outside the three repos).
export const fileClaudeStore = (path: string): ClaudeStore => ({
    read: async () => {
        try {
            return JSON.parse(await readFile(path, "utf8")) as StoredAccount;
        } catch {
            return undefined;
        }
    },
    write: async (account) => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, `${JSON.stringify(account, undefined, 2)}\n`);
    },
    clear: () => rm(path, { force: true }),
});

// Return a usable access token for the stored account, refreshing + persisting first if it has expired (or is
// about to) and a refresh token is available. undefined when no account is connected — callers then fall back
// to the container's ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN env (if any).
export const ensureFreshToken = async (store: ClaudeStore, refresh: RefreshFn = refreshTokens): Promise<string | undefined> => {
    const account = await store.read();
    if (account === undefined) {
        return undefined;
    }
    const stillValid = account.expiresAt === undefined || account.expiresAt - Date.now() > EXPIRY_SKEW_MS;
    if (stillValid || account.refreshToken === undefined) {
        return account.accessToken;
    }
    const refreshed = await refresh(account.refreshToken);
    const next: StoredAccount = { ...refreshed, refreshToken: refreshed.refreshToken ?? account.refreshToken };
    await store.write(next);
    return next.accessToken;
};
