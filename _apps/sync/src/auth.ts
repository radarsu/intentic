import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { OAuth2Client } from "google-auth-library";

// The sandbox daemon authenticates the owner by a verified Google ID token — same as the browser. The agent
// reuses that: a one-time desktop OAuth loopback (below) yields a refresh token; every run mints a fresh ID
// token from it with no browser. openid+email give the daemon the verified email it binds ownership to.
const SCOPES = ["openid", "email", "profile"];
const TOKEN_URL = "https://oauth2.googleapis.com/token";

const openBrowser = (url: string): void => {
    const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    try {
        spawn(command, args, { stdio: "ignore", detached: true }).unref();
    } catch {
        // No opener available (headless box) — the URL is also printed for the user to open manually.
    }
};

const startLoopback = (): Promise<{ server: Server; port: number; code: Promise<string> }> =>
    new Promise((resolveServer) => {
        let resolveCode: (code: string) => void = () => {};
        let rejectCode: (error: Error) => void = () => {};
        const code = new Promise<string>((resolve, reject) => {
            resolveCode = resolve;
            rejectCode = reject;
        });
        const server = createServer((request, response) => {
            const url = new URL(request.url ?? "/", "http://localhost");
            const received = url.searchParams.get("code");
            const error = url.searchParams.get("error");
            response.writeHead(200, { "content-type": "text/html" });
            response.end("<html><body>intentic-sync authorized. You can close this tab.</body></html>");
            if (received !== null) {
                resolveCode(received);
                return;
            }
            if (error !== null) {
                rejectCode(new Error(`Google authorization was denied: ${error}`));
            }
        });
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            resolveServer({ server, port: typeof address === "object" && address !== null ? address.port : 0, code });
        });
    });

// Interactive first-run: open Google's consent screen, capture the redirect on a loopback port, and exchange
// the code for a refresh token. `prompt=consent` + `access_type=offline` forces Google to return a refresh
// token even on a re-auth (it otherwise omits it once granted).
export const authorizeInteractive = async (clientId: string, clientSecret: string): Promise<string> => {
    const { server, port, code } = await startLoopback();
    const redirectUri = `http://localhost:${port}`;
    const client = new OAuth2Client({ clientId, clientSecret, redirectUri });
    const authUrl = client.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: SCOPES });
    openBrowser(authUrl);
    process.stdout.write(`\nAuthorize intentic-sync in your browser (opening it now):\n${authUrl}\n\n`);
    try {
        const authorizationCode = await code;
        const { tokens } = await client.getToken({ code: authorizationCode, redirect_uri: redirectUri });
        if (typeof tokens.refresh_token !== "string" || tokens.refresh_token === "") {
            throw new Error("Google returned no refresh token — remove intentic-sync from your Google account's third-party access and retry.");
        }
        return tokens.refresh_token;
    } finally {
        server.close();
    }
};

// Mint a short-lived ID token from the stored refresh token. Plain token-endpoint call so the ID token comes
// back directly (the library's access-token path doesn't surface it). Google caps ID tokens at ~1h, so the run
// loop refreshes before each reconnect.
export const idTokenFromRefresh = async (clientId: string, clientSecret: string, refreshToken: string): Promise<string> => {
    const response = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
    });
    if (!response.ok) {
        throw new Error(`Google token refresh failed (${response.status}): ${await response.text()}`);
    }
    const payload = (await response.json()) as { id_token?: string };
    if (typeof payload.id_token !== "string") {
        throw new Error("Google token refresh returned no id_token");
    }
    return payload.id_token;
};
