import { z } from "zod";
import { parseResponse } from "./inputs.js";

// A Komodo Core resource summary (id + unique name) and the typed Alerter config the CD-notify provider
// reconciles. Komodo's API is POST /{auth|read|write|execute}/{Operation} with a {type, params} body; it
// returns the operation result JSON directly and signals errors with a non-2xx status + {message,...}.
// Read responses are validated against the fields we consume (extra fields dropped); write/execute ops
// ignore the body (only the status matters).

export interface KomodoResource {
    readonly id: string;
    readonly name: string;
}

// The slice of a Deployment's config the deployment provider diffs against — the authored fields it
// converges (server, branch, build image, env). Extra fields Komodo returns are dropped by zod.
const deploymentConfigSchema = z.object({
    server_id: z.string(),
    branch: z.string(),
    image: z.object({ type: z.string(), params: z.object({ build: z.string() }) }),
    environment: z.array(z.object({ variable: z.string(), value: z.string() })).readonly(),
});
export type DeploymentConfig = z.infer<typeof deploymentConfigSchema>;

const alerterEndpointSchema = z.object({ type: z.enum(["Discord", "Slack", "Custom"]), params: z.object({ url: z.string() }) });
const resourceTargetSchema = z.object({ type: z.string(), id: z.string() });
const alerterConfigSchema = z.object({
    enabled: z.boolean(),
    endpoint: alerterEndpointSchema,
    alert_types: z.array(z.string()).readonly(),
    resources: z.array(resourceTargetSchema).readonly(),
    except_resources: z.array(resourceTargetSchema).readonly(),
});
export type AlerterEndpoint = z.infer<typeof alerterEndpointSchema>;
export type ResourceTarget = z.infer<typeof resourceTargetSchema>;
export type AlerterConfig = z.infer<typeof alerterConfigSchema>;

// ListX returns ResourceListItem<Info>[]; we validate id/name (+ deployment run state from info) and drop
// the rest. The login result is the JwtOrTwoFactor enum's Jwt variant in either flattened or tagged form.
const listItemSchema = z.object({ id: z.string(), name: z.string() });
const jwtSchema = z.object({ jwt: z.string().optional(), Jwt: z.object({ jwt: z.string() }).optional() });
const getAlerterSchema = z.object({ config: alerterConfigSchema });
const getDeploymentSchema = z.object({ config: deploymentConfigSchema });

// The slice of the Komodo Core API the app/deployment/komodo-notify providers use, injected so the
// providers are unit-testable with a fake; the default `komodoApi` below talks to a Komodo Core over
// native fetch. Auth is a JWT minted per provider call via local-admin login (never baked in). Build and
// deployment configs are provider-built and passed through opaquely (their exact v2 JSON shapes are
// confirmed at integration time); the alerter config is typed because the notify provider diffs it.
export interface KomodoApi {
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
    readonly listDeployments: (args: { readonly baseUrl: string; readonly jwt: string }) => Promise<readonly KomodoResource[]>;
    // read/GetDeployment {deployment: <id or name>} -> the authored config slice the provider diffs.
    readonly getDeployment: (args: { readonly baseUrl: string; readonly jwt: string; readonly deployment: string }) => Promise<DeploymentConfig>;
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

interface PostArgs {
    readonly baseUrl: string;
    readonly module: Module;
    readonly type: string;
    readonly params: Readonly<Record<string, unknown>>;
    readonly jwt?: string;
}

// POST the {type, params} envelope; throw on a non-2xx status. Write/execute ops use this directly and
// ignore the body; read ops layer response validation on top via `read`.
const post = async (args: PostArgs): Promise<Response> => {
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
    return response;
};

const read = async <S extends z.ZodType>(args: PostArgs, schema: S): Promise<z.infer<S>> =>
    parseResponse(schema, await (await post(args)).json(), `Komodo ${args.module}/${args.type}`);

const project = (items: readonly z.infer<typeof listItemSchema>[]): readonly KomodoResource[] =>
    items.map((item) => ({ id: item.id, name: item.name }));

export const komodoApi: KomodoApi = {
    login: async ({ baseUrl, username, password }) => {
        const result = await read({ baseUrl, module: "auth", type: "LoginLocalUser", params: { username, password } }, jwtSchema);
        const jwt = result.jwt ?? result.Jwt?.jwt;
        if (jwt === undefined) {
            throw new Error("Komodo auth/LoginLocalUser returned no jwt (is local auth enabled?)");
        }
        return jwt;
    },
    listBuilds: async ({ baseUrl, jwt }) =>
        project(await read({ baseUrl, module: "read", type: "ListBuilds", params: {}, jwt }, z.array(listItemSchema))),
    createBuild: async ({ baseUrl, jwt, name, config }) => {
        await post({ baseUrl, module: "write", type: "CreateBuild", params: { name, config }, jwt });
    },
    updateBuild: async ({ baseUrl, jwt, id, config }) => {
        await post({ baseUrl, module: "write", type: "UpdateBuild", params: { id, config }, jwt });
    },
    listDeployments: async ({ baseUrl, jwt }) =>
        project(await read({ baseUrl, module: "read", type: "ListDeployments", params: {}, jwt }, z.array(listItemSchema))),
    getDeployment: async ({ baseUrl, jwt, deployment }) =>
        (await read({ baseUrl, module: "read", type: "GetDeployment", params: { deployment }, jwt }, getDeploymentSchema)).config,
    createDeployment: async ({ baseUrl, jwt, name, config }) => {
        await post({ baseUrl, module: "write", type: "CreateDeployment", params: { name, config }, jwt });
    },
    updateDeployment: async ({ baseUrl, jwt, id, config }) => {
        await post({ baseUrl, module: "write", type: "UpdateDeployment", params: { id, config }, jwt });
    },
    deploy: async ({ baseUrl, jwt, deployment }) => {
        await post({ baseUrl, module: "execute", type: "Deploy", params: { deployment }, jwt });
    },
    listAlerters: async ({ baseUrl, jwt }) =>
        project(await read({ baseUrl, module: "read", type: "ListAlerters", params: {}, jwt }, z.array(listItemSchema))),
    getAlerter: async ({ baseUrl, jwt, id }) =>
        (await read({ baseUrl, module: "read", type: "GetAlerter", params: { alerter: id }, jwt }, getAlerterSchema)).config,
    createAlerter: async ({ baseUrl, jwt, name, config }) => {
        await post({ baseUrl, module: "write", type: "CreateAlerter", params: { name, config }, jwt });
    },
    updateAlerter: async ({ baseUrl, jwt, id, config }) => {
        await post({ baseUrl, module: "write", type: "UpdateAlerter", params: { id, config }, jwt });
    },
};
