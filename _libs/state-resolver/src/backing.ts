import type { Ref } from "@intentic/graph";
import { generated, makeRef } from "@intentic/graph";
import type { BackingCapability, BackingIntent, HostInput } from "@intentic/need-resolver";
import type { ResolvedNode, ResourceType } from "@intentic/resources";
import { backingPort, bindingId, cacheUser, dbName, secretKey } from "./ids.js";
import { IMAGES } from "./images.js";
import type { IngressPair } from "./route.js";

// The backing catalog: each abstract capability mapped to the concrete resource its provider deploys, the
// per-app binding resource that provisions an app's isolated credentials on it, the pinned image, and
// whether instances of it route publicly. Adding a capability is one entry here plus a provider — the
// authoring surface (i.want.database / cache) is unchanged. Auth / object-storage land in Phase 2.
interface BackingSpec {
    readonly type: ResourceType;
    readonly bindingType: ResourceType;
    readonly image: string;
    // Whether an instance is exposed through Cloudflare. database/cache are internal-only (false): apps reach
    // them over the host's internal ip, never a tunnel-routed hostname.
    readonly routes: boolean;
}

const catalog: Readonly<Record<BackingCapability, BackingSpec>> = {
    database: { type: "postgres", bindingType: "postgres-database", image: IMAGES.postgres, routes: false },
    cache: { type: "valkey", bindingType: "valkey-namespace", image: IMAGES.valkey, routes: false },
    // Phase 2. Present so the resolver/emit handle the capabilities exhaustively; the providers are added with
    // the HTTP-API integration in Phase 2.
    auth: { type: "authentik", bindingType: "authentik-client", image: "", routes: true },
    "object-storage": { type: "garage", bindingType: "garage-bucket", image: "", routes: false },
};

// The env vars a binding injects into a consuming app's deployments, each mapping an env var name to the
// output it reads off the per-app binding node. Spread before the author's env so an explicit override wins.
// REDIS_URL is an alias of VALKEY_URL so libraries that default to it work without extra config.
const envContract: Readonly<Record<BackingCapability, readonly (readonly [string, string])[]>> = {
    database: [["DATABASE_URL", "url"]],
    cache: [
        ["VALKEY_URL", "url"],
        ["REDIS_URL", "url"],
    ],
    auth: [
        ["OIDC_ISSUER", "issuer"],
        ["OIDC_CLIENT_ID", "clientId"],
        ["OIDC_CLIENT_SECRET", "clientSecret"],
    ],
    "object-storage": [
        ["S3_ENDPOINT", "endpoint"],
        ["S3_ACCESS_KEY", "accessKey"],
        ["S3_SECRET_KEY", "secretKey"],
        ["S3_BUCKET", "bucket"],
    ],
};

// The SSH connection block from a HostInput (the backing instance + its binding nodes both deploy onto it).
const sshOf = (input: HostInput): Record<string, unknown> => ({
    address: input.address,
    user: input.user,
    sshKey: input.sshKey,
    ...(input.port !== undefined ? { port: input.port } : {}),
});

// The generated admin secret key a backing instance and its binding nodes share (same key -> same value via
// .secrets.json), so a binding can authenticate to the instance to mint per-app credentials.
const adminSecretKey = (capability: BackingCapability, instanceId: string): string =>
    secretKey(capability === "database" ? "POSTGRES_ADMIN_PASSWORD" : "VALKEY_ADMIN_PASSWORD", instanceId);

// A backing instance: one node deployed onto its host over SSH from a pinned image, with a generated admin
// password and a deterministic host port. Internal-only capabilities emit no Cloudflare route, so they carry
// no ingress; the provider's apply blocks until healthy (pg_isready / redis-cli ping), so no readyWhen gate.
export const resolveBacking = (intent: BackingIntent, host: HostInput): { nodes: ResolvedNode[]; ingress: IngressPair[] } => {
    const spec = catalog[intent.capability];
    if (spec.image === "") {
        throw new Error(`backing capability "${intent.capability}" is not yet implemented (Phase 2)`);
    }
    const node: ResolvedNode = {
        id: intent.id,
        type: spec.type,
        inputs: {
            server: makeRef(intent.on),
            ...sshOf(host),
            internalIp: makeRef<string>(intent.on, "internalIp"),
            // The host port the instance publishes on; named distinctly from the SSH `port` in the ssh block.
            publishPort: backingPort(intent.id),
            adminPassword: generated(adminSecretKey(intent.capability, intent.id)),
            image: spec.image,
        },
        explicitDependsOn: [intent.on],
    };
    return { nodes: [node], ingress: [] };
};

// The per-app binding node for one app consuming one backing instance: it provisions the app's isolated
// sub-resource (Postgres database+role / Valkey ACL user) on the instance over SSH and produces the
// connection URL injected into the app's deployments. Carries the instance's SSH block + admin secret (to
// authenticate) and a per-app generated password. Depends on the instance so it runs once it is healthy.
export const resolveBinding = (appId: string, intent: BackingIntent, host: HostInput): ResolvedNode => {
    const spec = catalog[intent.capability];
    const id = bindingId(appId, intent.id);
    const shared = {
        ...sshOf(host),
        // The instance to docker-exec into (its node id, stamped as the container's intentic.id label) and the
        // host coordinates the produced connection URL embeds. `instancePort` is distinct from the SSH `port`.
        instance: intent.id,
        instanceHost: makeRef<string>(intent.id, "internalHost"),
        instancePort: makeRef<string>(intent.id, "port"),
    };
    if (intent.capability === "database") {
        return {
            id,
            type: spec.bindingType,
            inputs: { ...shared, database: dbName(appId), role: dbName(appId), password: generated(secretKey("APP_DATABASE_PASSWORD", id)) },
            explicitDependsOn: [intent.id],
        };
    }
    // cache: a Valkey ACL user scoped to the app's key prefix; the binding needs the admin password to run
    // ACL SETUSER (valkey-cli auths with requirepass).
    return {
        id,
        type: spec.bindingType,
        inputs: {
            ...shared,
            adminPassword: generated(adminSecretKey(intent.capability, intent.id)),
            username: cacheUser(appId),
            password: generated(secretKey("APP_CACHE_PASSWORD", id)),
            keyPrefix: cacheUser(appId),
        },
        explicitDependsOn: [intent.id],
    };
};

// The env injection an app's deployments receive for one binding: each contract var as a ref to the binding
// node's output. Used by resolveApp to merge into every deployment's env (before the author's own env).
export const bindingEnv = (appId: string, intent: BackingIntent): Record<string, Ref<string>> => {
    const id = bindingId(appId, intent.id);
    const env: Record<string, Ref<string>> = {};
    for (const [name, output] of envContract[intent.capability]) {
        env[name] = makeRef<string>(id, output);
    }
    return env;
};
