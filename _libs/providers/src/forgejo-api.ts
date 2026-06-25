import { z } from "zod";
import { parseResponse } from "./inputs.js";

// A Forgejo repo and one of its webhooks. Forgejo's REST surface returns the resource JSON directly (no
// success envelope); errors arrive with a non-2xx status, and otherwise the body is validated against the
// fields we consume (extra fields like timestamps are dropped).
export interface ForgejoRepo {
    readonly cloneUrl: string;
    readonly sshUrl: string;
}

const rawRepoSchema = z.object({ clone_url: z.string(), ssh_url: z.string() });
const rawCommitSchema = z.object({ sha: z.string() });
const rawContentSchema = z.object({ sha: z.string() });

// Percent-encode each path segment but keep the slashes, so a nested file path stays a valid URL path.
const encodePath = (path: string): string => path.split("/").map(encodeURIComponent).join("/");

export const forgejoHookSchema = z.object({
    id: z.number(),
    type: z.string(),
    config: z.record(z.string(), z.string()),
    events: z.array(z.string()),
    active: z.boolean(),
});
export type ForgejoHook = z.infer<typeof forgejoHookSchema>;

// The slice of the Forgejo v4 API the repo/ci/notify providers use, injected so the providers
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
    // Create a repo owned by `owner` (admin-for-user). `autoInit` makes Forgejo write an initial commit (so an
    // app repo can be cloned immediately); pass false to get an EMPTY repo when local history will be pushed in.
    readonly createRepo: (args: {
        readonly baseUrl: string;
        readonly user: string;
        readonly password: string;
        readonly owner: string;
        readonly name: string;
        readonly private: boolean;
        readonly autoInit: boolean;
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
    // The latest commit sha on `branch`; undefined when the repo has no commits on it yet.
    readonly latestCommit: (args: {
        readonly baseUrl: string;
        readonly user: string;
        readonly password: string;
        readonly owner: string;
        readonly name: string;
        readonly branch: string;
    }) => Promise<string | undefined>;
    // The raw contents of `path` on `branch`; undefined if it does not exist (404).
    readonly readFile: (args: {
        readonly baseUrl: string;
        readonly user: string;
        readonly password: string;
        readonly owner: string;
        readonly name: string;
        readonly branch: string;
        readonly path: string;
    }) => Promise<string | undefined>;
    // Create or replace `path` on `branch` with `content` (utf-8), committing with `message`.
    readonly commitFile: (args: {
        readonly baseUrl: string;
        readonly user: string;
        readonly password: string;
        readonly owner: string;
        readonly name: string;
        readonly branch: string;
        readonly path: string;
        readonly content: string;
        readonly message: string;
    }) => Promise<void>;
    // Create or replace a repo Actions secret (consumed by the CI workflow). Forgejo takes the PLAINTEXT value
    // as `data` (unlike GitHub's libsodium sealed box), create-or-replaced in place with a single PUT.
    readonly setRepoSecret: (args: {
        readonly baseUrl: string;
        readonly user: string;
        readonly password: string;
        readonly owner: string;
        readonly name: string;
        readonly secretName: string;
        readonly data: string;
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

const toRepo = (raw: z.infer<typeof rawRepoSchema>): ForgejoRepo => ({ cloneUrl: raw.clone_url, sshUrl: raw.ssh_url });

export const forgejoApi: ForgejoApi = {
    findRepo: async ({ baseUrl, user, password, owner, name }) => {
        const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
        const response = await request({ method: "GET", baseUrl, path, user, password });
        if (response.status === 404) {
            return undefined;
        }
        return toRepo(parseResponse(rawRepoSchema, await (await ok(response, "GET", path)).json(), `Forgejo API GET ${path}`));
    },
    createRepo: async ({ baseUrl, user, password, owner, name, private: isPrivate, autoInit }) => {
        const path = `/admin/users/${encodeURIComponent(owner)}/repos`;
        const response = await request({ method: "POST", baseUrl, path, user, password, body: { name, private: isPrivate, auto_init: autoInit } });
        return toRepo(parseResponse(rawRepoSchema, await (await ok(response, "POST", path)).json(), `Forgejo API POST ${path}`));
    },
    listHooks: async ({ baseUrl, user, password, owner, name }) => {
        const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/hooks`;
        const response = await request({ method: "GET", baseUrl, path, user, password });
        return parseResponse(z.array(forgejoHookSchema), await (await ok(response, "GET", path)).json(), `Forgejo API GET ${path}`);
    },
    createHook: async ({ baseUrl, user, password, owner, name, type, config, events }) => {
        const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/hooks`;
        await ok(await request({ method: "POST", baseUrl, path, user, password, body: { type, config, events, active: true } }), "POST", path);
    },
    updateHook: async ({ baseUrl, user, password, owner, name, id, config, events }) => {
        const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/hooks/${id}`;
        await ok(await request({ method: "PATCH", baseUrl, path, user, password, body: { config, events, active: true } }), "PATCH", path);
    },
    latestCommit: async ({ baseUrl, user, password, owner, name, branch }) => {
        const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/commits?sha=${encodeURIComponent(branch)}&limit=1`;
        const response = await request({ method: "GET", baseUrl, path, user, password });
        // An empty repo answers 409 and a missing branch 404; either way nothing has been pushed yet.
        if (!response.ok) {
            return undefined;
        }
        const commits = parseResponse(z.array(rawCommitSchema), await response.json(), `Forgejo API GET ${path}`);
        return commits[0]?.sha;
    },
    readFile: async ({ baseUrl, user, password, owner, name, branch, path: filePath }) => {
        const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/raw/${encodePath(filePath)}?ref=${encodeURIComponent(branch)}`;
        const response = await request({ method: "GET", baseUrl, path, user, password });
        if (response.status === 404) {
            return undefined;
        }
        return (await ok(response, "GET", path)).text();
    },
    commitFile: async ({ baseUrl, user, password, owner, name, branch, path: filePath, content, message }) => {
        const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/${encodePath(filePath)}`;
        const base64 = Buffer.from(content).toString("base64");
        // Forgejo's contents API creates with POST and replaces with PUT (which requires the current blob
        // sha), so look the file up first and branch on whether it already exists.
        const existing = await request({ method: "GET", baseUrl, path: `${path}?ref=${encodeURIComponent(branch)}`, user, password });
        if (existing.status === 404) {
            await ok(await request({ method: "POST", baseUrl, path, user, password, body: { content: base64, message, branch } }), "POST", path);
            return;
        }
        const current = parseResponse(rawContentSchema, await (await ok(existing, "GET", path)).json(), `Forgejo API GET ${path}`);
        await ok(
            await request({ method: "PUT", baseUrl, path, user, password, body: { content: base64, message, branch, sha: current.sha } }),
            "PUT",
            path,
        );
    },
    setRepoSecret: async ({ baseUrl, user, password, owner, name, secretName, data }) => {
        const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions/secrets/${encodeURIComponent(secretName)}`;
        // PUT is create-or-replace; Forgejo accepts the plaintext value as `data`. 201 (created) / 204 (updated) both ok().
        await ok(await request({ method: "PUT", baseUrl, path, user, password, body: { data } }), "PUT", path);
    },
};
