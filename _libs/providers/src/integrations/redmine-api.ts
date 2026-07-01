import { z } from "zod";

// A thin typed wrapper over the Redmine REST API — only the one operation intentic needs in v1: confirm an
// API key is valid by reading the authenticated user. Auth is the API key in the X-Redmine-API-Key header.
// Injectable for tests (same pattern as StripeApi / DiscordApi). `url` is the self-hosted instance base.

export interface RedmineUser {
    readonly id: number;
}

const userSchema = z.object({ user: z.object({ id: z.number() }) });

export interface RedmineApi {
    // GET {url}/users/current.json — the authenticated user for a valid key, or undefined when rejected (401/403).
    readonly getCurrentUser: (url: string, apiKey: string) => Promise<RedmineUser | undefined>;
}

export const redmineApi: RedmineApi = {
    getCurrentUser: async (url, apiKey) => {
        const base = url.replace(/\/+$/, "");
        const response = await fetch(`${base}/users/current.json`, { headers: { "X-Redmine-API-Key": apiKey } });
        if (response.status === 401 || response.status === 403) {
            return undefined;
        }
        if (!response.ok) {
            throw new Error(`Redmine GET /users/current.json failed (HTTP ${response.status}): ${await response.text()}`);
        }
        return userSchema.parse(await response.json()).user;
    },
};
