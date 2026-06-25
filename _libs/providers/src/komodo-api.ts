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

// The slice of a Deployment's config the deployment provider diffs against — the one authored MUTABLE field
// it converges, `environment`. server_id and the build image are fixed at creation (like the deterministic
// ports); branch is a Build concept that a Deployment does not carry (GetDeployment never returns it). Komodo
// stores `environment` as a multiline string ("K = V\n") but also accepts the array-of-{variable,value} form
// we send, so read must tolerate both; other fields Komodo returns (server_id/image/ports/...) pass through.
const deploymentConfigSchema = z
    .object({
        environment: z.union([z.string(), z.array(z.object({ variable: z.string(), value: z.string() }))]).default(""),
    })
    .passthrough();
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
// the rest. The login result is the JwtOrTwoFactor enum, internally tagged: {"type":"Jwt","data":{"jwt"}}
// on success, {"type":"Totp"|"Passkey",...} when 2FA is required.
const listItemSchema = z.object({ id: z.string(), name: z.string() });
const loginSchema = z.object({ type: z.string(), data: z.object({ jwt: z.string() }).optional() });
// The slice of GetBuild the deployment provider polls to know a RunBuild has finished: last_built_at is 0
// until the first successful build and advances on each subsequent one; remote_error carries a git-fetch
// failure so a stuck build's timeout message is actionable.
const buildStatusSchema = z.object({
    info: z.object({ last_built_at: z.number().default(0), remote_error: z.string().nullish() }).passthrough(),
});
export interface BuildStatus {
    readonly lastBuiltAt: number;
    readonly remoteError: string | undefined;
}
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
    readonly listBuilders: (args: { readonly baseUrl: string; readonly jwt: string }) => Promise<readonly KomodoResource[]>;
    // A Build needs a Builder attached or RunBuild errors "Must attach builder"; a Server builder builds on
    // the named server's Periphery.
    readonly createBuilder: (args: {
        readonly baseUrl: string;
        readonly jwt: string;
        readonly name: string;
        readonly config: Readonly<Record<string, unknown>>;
    }) => Promise<void>;
    // execute/RunBuild {build} — builds the image. RunBuild returns once the build STARTS (it runs async on
    // the builder), and execute/Deploy does NOT build; it only pulls + runs. So a create/update must RunBuild,
    // wait for the image via getBuild, then Deploy.
    readonly runBuild: (args: { readonly baseUrl: string; readonly jwt: string; readonly build: string }) => Promise<void>;
    // read/GetBuild {build} -> the build's status; last_built_at advances when a RunBuild produces an image.
    readonly getBuild: (args: { readonly baseUrl: string; readonly jwt: string; readonly build: string }) => Promise<BuildStatus>;
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

type Module = "read" | "write" | "execute";

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
            // Komodo expects the bare JWT in Authorization (no "Bearer " prefix), unlike most APIs.
            ...(args.jwt !== undefined ? { Authorization: args.jwt } : {}),
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
        // Auth is the external mogh_auth surface: POST /auth/login/<Operation> with the BARE params (not the
        // {type,params} envelope of /read|/write|/execute), and the JWT comes back internally tagged under .data.
        const response = await fetch(`${baseUrl}/auth/login/LoginLocalUser`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username, password }),
        });
        if (!response.ok) {
            throw new Error(`Komodo auth/login/LoginLocalUser failed (HTTP ${response.status}): ${await response.text()}`);
        }
        const result = parseResponse(loginSchema, await response.json(), "Komodo auth/login/LoginLocalUser");
        if (result.type !== "Jwt" || result.data === undefined) {
            throw new Error(`Komodo login did not return a Jwt (got "${result.type}"; 2FA is not supported)`);
        }
        return result.data.jwt;
    },
    listBuilds: async ({ baseUrl, jwt }) =>
        project(await read({ baseUrl, module: "read", type: "ListBuilds", params: {}, jwt }, z.array(listItemSchema))),
    createBuild: async ({ baseUrl, jwt, name, config }) => {
        await post({ baseUrl, module: "write", type: "CreateBuild", params: { name, config }, jwt });
    },
    updateBuild: async ({ baseUrl, jwt, id, config }) => {
        await post({ baseUrl, module: "write", type: "UpdateBuild", params: { id, config }, jwt });
    },
    listBuilders: async ({ baseUrl, jwt }) =>
        project(await read({ baseUrl, module: "read", type: "ListBuilders", params: {}, jwt }, z.array(listItemSchema))),
    createBuilder: async ({ baseUrl, jwt, name, config }) => {
        await post({ baseUrl, module: "write", type: "CreateBuilder", params: { name, config }, jwt });
    },
    runBuild: async ({ baseUrl, jwt, build }) => {
        await post({ baseUrl, module: "execute", type: "RunBuild", params: { build }, jwt });
    },
    getBuild: async ({ baseUrl, jwt, build }) => {
        const result = await read({ baseUrl, module: "read", type: "GetBuild", params: { build }, jwt }, buildStatusSchema);
        return { lastBuiltAt: result.info.last_built_at, remoteError: result.info.remote_error ?? undefined };
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
