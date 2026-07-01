import { z } from "zod";

// A thin typed wrapper over the Outline API — only the one operation intentic needs in v1: confirm an API token
// is valid by reading the auth info. Auth is the token as a Bearer credential. Injectable for tests (same
// pattern as StripeApi / RedmineApi). `url` is the self-hosted instance base.

export interface OutlineUser {
    readonly id: string;
}

const authInfoSchema = z.object({ data: z.object({ user: z.object({ id: z.string() }) }) });

export interface OutlineApi {
    // POST {url}/api/auth.info — the authenticated user for a valid token, or undefined when rejected (401/403).
    readonly getAuthInfo: (url: string, token: string) => Promise<OutlineUser | undefined>;
}

export const outlineApi: OutlineApi = {
    getAuthInfo: async (url, token) => {
        const base = url.replace(/\/+$/, "");
        const response = await fetch(`${base}/api/auth.info`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
        if (response.status === 401 || response.status === 403) {
            return undefined;
        }
        if (!response.ok) {
            throw new Error(`Outline POST /api/auth.info failed (HTTP ${response.status}): ${await response.text()}`);
        }
        return authInfoSchema.parse(await response.json()).data.user;
    },
};
