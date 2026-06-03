// A Komodo Core resource summary (id + unique name) and the typed Alerter config the CD-notify provider
// reconciles. Komodo's API is POST /{auth|read|write|execute}/{Operation} with a {type, params} body;
// it returns the operation result JSON directly and signals errors with a non-2xx status + {message,...}.

export interface KomodoResource {
    readonly id: string;
    readonly name: string;
}

// A deployment list item carries its current run state, which the deployment provider diffs against.
export interface KomodoDeployment extends KomodoResource {
    readonly state?: string;
}

export interface AlerterEndpoint {
    readonly type: "Discord" | "Slack" | "Custom";
    readonly params: { readonly url: string };
}

export interface ResourceTarget {
    readonly type: string;
    readonly id: string;
}

export interface AlerterConfig {
    readonly enabled: boolean;
    readonly endpoint: AlerterEndpoint;
    readonly alert_types: readonly string[];
    readonly resources: readonly ResourceTarget[];
    readonly except_resources: readonly ResourceTarget[];
}

// The slice of the Komodo Core API the app/deployment/komodo-notify providers use, injected so the
// providers are unit-testable with a fake; the default `komodoApi` below talks to a Komodo Core over
// native fetch. Auth is a JWT minted per provider call via local-admin login (never baked in). Build and
// deployment configs are provider-built and passed through opaquely (their exact v2 JSON shapes are
// confirmed at integration time); the alerter config is typed because the notify provider diffs it.
export interface KomodoApi {
    // GET /api/health — true iff Core answers 2xx. Never throws on an unhealthy-but-reachable Core.
    readonly health: (args: { readonly baseUrl: string }) => Promise<boolean>;
    // POST /auth/LoginLocalUser {username,password} -> jwt (local auth must be enabled).
    readonly login: (args: { readonly baseUrl: string; readonly username: string; readonly password: string }) => Promise<string>;
    readonly listBuilds: (args: { readonly baseUrl: string; readonly jwt: string }) => Promise<readonly KomodoResource[]>;
    readonly createBuild: (args: {
        readonly baseUrl: string;
        readonly jwt: string;
        readonly name: string;
        readonly config: Readonly<Record<string, unknown>>;
    }) => Promise<void>;
    readonly updateBuild: (args: {
        readonly baseUrl: string;
        readonly jwt: string;
        readonly id: string;
        readonly config: Readonly<Record<string, unknown>>;
    }) => Promise<void>;
    readonly listDeployments: (args: { readonly baseUrl: string; readonly jwt: string }) => Promise<readonly KomodoDeployment[]>;
    readonly createDeployment: (args: {
        readonly baseUrl: string;
        readonly jwt: string;
        readonly name: string;
        readonly config: Readonly<Record<string, unknown>>;
    }) => Promise<void>;
    readonly updateDeployment: (args: {
        readonly baseUrl: string;
        readonly jwt: string;
        readonly id: string;
        readonly config: Readonly<Record<string, unknown>>;
    }) => Promise<void>;
    // execute/Deploy {deployment: <id or name>} — triggers the deployment.
    readonly deploy: (args: { readonly baseUrl: string; readonly jwt: string; readonly deployment: string }) => Promise<void>;
    readonly listAlerters: (args: { readonly baseUrl: string; readonly jwt: string }) => Promise<readonly KomodoResource[]>;
    readonly getAlerter: (args: { readonly baseUrl: string; readonly jwt: string; readonly id: string }) => Promise<AlerterConfig>;
    readonly createAlerter: (args: {
        readonly baseUrl: string;
        readonly jwt: string;
        readonly name: string;
        readonly config: AlerterConfig;
    }) => Promise<void>;
    readonly updateAlerter: (args: {
        readonly baseUrl: string;
        readonly jwt: string;
        readonly id: string;
        readonly config: AlerterConfig;
    }) => Promise<void>;
}

type Module = "auth" | "read" | "write" | "execute";

const call = async <T>(args: {
    readonly baseUrl: string;
    readonly module: Module;
    readonly type: string;
    readonly params: Readonly<Record<string, unknown>>;
    readonly jwt?: string;
}): Promise<T> => {
    const response = await fetch(`${args.baseUrl}/${args.module}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...(args.jwt !== undefined ? { Authorization: `Bearer ${args.jwt}` } : {}),
        },
        body: JSON.stringify({ type: args.type, params: args.params }),
    });
    if (!response.ok) {
        throw new Error(`Komodo ${args.module}/${args.type} failed (HTTP ${response.status}): ${await response.text()}`);
    }
    return (await response.json()) as T;
};

// ListX returns ResourceListItem<Info>[]; we project to id/name (+ deployment run state from info).
interface RawListItem {
    readonly id: string;
    readonly name: string;
    readonly info?: { readonly state?: string };
}

const project = (items: readonly RawListItem[]): readonly KomodoResource[] => items.map((item) => ({ id: item.id, name: item.name }));

export const komodoApi: KomodoApi = {
    health: async ({ baseUrl }) => {
        const response = await fetch(`${baseUrl}/api/health`, { method: "GET" });
        return response.ok;
    },
    login: async ({ baseUrl, username, password }) => {
        // JwtOrTwoFactor -> Jwt(JwtResponse{jwt}); accept both the flattened and serde-tagged shapes.
        const raw = await call<{ jwt?: string; Jwt?: { jwt: string } }>({
            baseUrl,
            module: "auth",
            type: "LoginLocalUser",
            params: { username, password },
        });
        const jwt = raw.jwt ?? raw.Jwt?.jwt;
        if (jwt === undefined) {
            throw new Error("Komodo auth/LoginLocalUser returned no jwt (is local auth enabled?)");
        }
        return jwt;
    },
    listBuilds: async ({ baseUrl, jwt }) =>
        project(await call<readonly RawListItem[]>({ baseUrl, module: "read", type: "ListBuilds", params: {}, jwt })),
    createBuild: async ({ baseUrl, jwt, name, config }) => {
        await call({ baseUrl, module: "write", type: "CreateBuild", params: { name, config }, jwt });
    },
    updateBuild: async ({ baseUrl, jwt, id, config }) => {
        await call({ baseUrl, module: "write", type: "UpdateBuild", params: { id, config }, jwt });
    },
    listDeployments: async ({ baseUrl, jwt }) => {
        const items = await call<readonly RawListItem[]>({ baseUrl, module: "read", type: "ListDeployments", params: {}, jwt });
        return items.map((item) => ({ id: item.id, name: item.name, ...(item.info?.state !== undefined ? { state: item.info.state } : {}) }));
    },
    createDeployment: async ({ baseUrl, jwt, name, config }) => {
        await call({ baseUrl, module: "write", type: "CreateDeployment", params: { name, config }, jwt });
    },
    updateDeployment: async ({ baseUrl, jwt, id, config }) => {
        await call({ baseUrl, module: "write", type: "UpdateDeployment", params: { id, config }, jwt });
    },
    deploy: async ({ baseUrl, jwt, deployment }) => {
        await call({ baseUrl, module: "execute", type: "Deploy", params: { deployment }, jwt });
    },
    listAlerters: async ({ baseUrl, jwt }) =>
        project(await call<readonly RawListItem[]>({ baseUrl, module: "read", type: "ListAlerters", params: {}, jwt })),
    getAlerter: async ({ baseUrl, jwt, id }) => {
        const resource = await call<{ config: AlerterConfig }>({ baseUrl, module: "read", type: "GetAlerter", params: { alerter: id }, jwt });
        return resource.config;
    },
    createAlerter: async ({ baseUrl, jwt, name, config }) => {
        await call({ baseUrl, module: "write", type: "CreateAlerter", params: { name, config }, jwt });
    },
    updateAlerter: async ({ baseUrl, jwt, id, config }) => {
        await call({ baseUrl, module: "write", type: "UpdateAlerter", params: { id, config }, jwt });
    },
};
