// A Forgejo repo and one of its webhooks. Forgejo's REST surface returns the resource JSON directly
// (no success envelope); errors arrive with a non-2xx status and a text/JSON body.
export interface ForgejoRepo {
    readonly cloneUrl: string;
    readonly sshUrl: string;
}

export interface ForgejoHook {
    readonly id: number;
    readonly type: string;
    readonly config: Readonly<Record<string, string>>;
    readonly events: readonly string[];
    readonly active: boolean;
}

// The slice of the Forgejo v4 API the repo/notify/deploy-hook providers use, injected so the providers
// are unit-testable with a fake; the default `forgejoApi` below talks to a Forgejo instance over native
// fetch. Auth flows per-call as HTTP Basic with the admin user + password (both resolved node inputs),
// never baked into the adapter at construction.
export interface ForgejoApi {
    // A repo under `owner`; undefined if it does not exist (404).
    readonly findRepo: (args: {
        readonly baseUrl: string;
        readonly user: string;
        readonly password: string;
        readonly owner: string;
        readonly name: string;
    }) => Promise<ForgejoRepo | undefined>;
    // Create a repo owned by `owner` (admin-for-user), initialized so it can be cloned immediately.
    readonly createRepo: (args: {
        readonly baseUrl: string;
        readonly user: string;
        readonly password: string;
        readonly owner: string;
        readonly name: string;
        readonly private: boolean;
    }) => Promise<ForgejoRepo>;
    // Every webhook on a repo, for stateless re-attribution (matched by type + config.url).
    readonly listHooks: (args: {
        readonly baseUrl: string;
        readonly user: string;
        readonly password: string;
        readonly owner: string;
        readonly name: string;
    }) => Promise<readonly ForgejoHook[]>;
    // Create a webhook (type "discord" for notifications, "gitea" for the Komodo deploy listener).
    readonly createHook: (args: {
        readonly baseUrl: string;
        readonly user: string;
        readonly password: string;
        readonly owner: string;
        readonly name: string;
        readonly type: string;
        readonly config: Readonly<Record<string, string>>;
        readonly events: readonly string[];
    }) => Promise<void>;
    // Replace an existing webhook's config + events in place.
    readonly updateHook: (args: {
        readonly baseUrl: string;
        readonly user: string;
        readonly password: string;
        readonly owner: string;
        readonly name: string;
        readonly id: number;
        readonly config: Readonly<Record<string, string>>;
        readonly events: readonly string[];
    }) => Promise<void>;
}

const authHeader = (user: string, password: string): string => `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

const request = async (args: {
    readonly method: string;
    readonly baseUrl: string;
    readonly path: string;
    readonly user: string;
    readonly password: string;
    readonly body?: unknown;
}): Promise<Response> =>
    fetch(`${args.baseUrl}/api/v1${args.path}`, {
        method: args.method,
        headers: {
            Authorization: authHeader(args.user, args.password),
            ...(args.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(args.body !== undefined ? { body: JSON.stringify(args.body) } : {}),
    });

const ok = async (response: Response, method: string, path: string): Promise<Response> => {
    if (!response.ok) {
        throw new Error(`Forgejo API ${method} ${path} failed (HTTP ${response.status}): ${await response.text()}`);
    }
    return response;
};

interface RawRepo {
    readonly clone_url: string;
    readonly ssh_url: string;
}

const toRepo = (raw: RawRepo): ForgejoRepo => ({ cloneUrl: raw.clone_url, sshUrl: raw.ssh_url });

export const forgejoApi: ForgejoApi = {
    findRepo: async ({ baseUrl, user, password, owner, name }) => {
        const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
        const response = await request({ method: "GET", baseUrl, path, user, password });
        if (response.status === 404) {
            return undefined;
        }
        const raw = (await (await ok(response, "GET", path)).json()) as RawRepo;
        return toRepo(raw);
    },
    createRepo: async ({ baseUrl, user, password, owner, name, private: isPrivate }) => {
        const path = `/admin/users/${encodeURIComponent(owner)}/repos`;
        const response = await request({ method: "POST", baseUrl, path, user, password, body: { name, private: isPrivate, auto_init: true } });
        const raw = (await (await ok(response, "POST", path)).json()) as RawRepo;
        return toRepo(raw);
    },
    listHooks: async ({ baseUrl, user, password, owner, name }) => {
        const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/hooks`;
        const response = await request({ method: "GET", baseUrl, path, user, password });
        return (await (await ok(response, "GET", path)).json()) as readonly ForgejoHook[];
    },
    createHook: async ({ baseUrl, user, password, owner, name, type, config, events }) => {
        const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/hooks`;
        await ok(await request({ method: "POST", baseUrl, path, user, password, body: { type, config, events, active: true } }), "POST", path);
    },
    updateHook: async ({ baseUrl, user, password, owner, name, id, config, events }) => {
        const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/hooks/${id}`;
        await ok(await request({ method: "PATCH", baseUrl, path, user, password, body: { config, events, active: true } }), "PATCH", path);
    },
};
