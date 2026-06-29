import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { DesiredStateGraph } from "@intentic/graph";
import { komodoApi } from "@intentic/providers";
import { loadEnvFile, readArtifact } from "./artifact.js";
import { readGeneratedSecrets } from "./generated-secrets.js";

// One app deployment as the platform's Apps view renders it: the desired config the resolver baked into the
// graph (image/env/url) plus whether Komodo currently has it registered, with a deep-link into Komodo for the
// runtime detail (logs, status) a dashboard should not rebuild.
export interface DeploymentView {
    readonly name: string;
    readonly image: string;
    readonly tag: string;
    readonly domain?: string;
    readonly url?: string;
    readonly port?: number;
    readonly env: Record<string, string>;
    readonly live: boolean;
    readonly komodoUrl: string;
    readonly komodoDeploymentUrl?: string;
}

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const asNumber = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);

// The env key for a `{$secret:{key}}` input — the resolver emits generated/admin passwords this way.
const secretKey = (value: unknown): string | undefined => {
    if (typeof value === "object" && value !== null && "$secret" in value) {
        const secret = (value as { $secret?: { key?: unknown } }).$secret;
        return typeof secret?.key === "string" ? secret.key : undefined;
    }
    return undefined;
};

// A deployment node's `env` input is a serialized record; surface keys with their scalar values, blanking any
// $ref/$secret value so a secret never leaves the sandbox.
const envOf = (value: unknown): Record<string, string> => {
    const env: Record<string, string> = {};
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
            env[key] = typeof val === "string" || typeof val === "number" || typeof val === "boolean" ? String(val) : "";
        }
    }
    return env;
};

// Resolve the Komodo control plane's public URL + admin login from the graph's `komodo` node. The admin
// password is a generated secret: env-first (the apply pipeline injects it), else the local .secrets.json the
// resolve step wrote in the sandbox.
const komodoAccess = (graph: DesiredStateGraph, generated: Record<string, string>): { url: string; user: string; password: string } | undefined => {
    const node = Object.values(graph.resources).find((resource) => resource.type === "komodo");
    if (node === undefined) {
        return undefined;
    }
    const domain = asString(node.inputs["domain"]);
    const user = asString(node.inputs["adminUser"]);
    const key = secretKey(node.inputs["adminPassword"]);
    const password = key !== undefined ? (process.env[key] ?? generated[key]) : undefined;
    if (domain === undefined || user === undefined || password === undefined || password === "") {
        return undefined;
    }
    return { url: `https://${domain}`, user, password };
};

// Build the Apps view for every `deployment` node in the artifact. Liveness is best-effort: when Komodo can be
// reached we confirm each deployment is registered (and capture its id for the deep-link); when it cannot, the
// configured deployments still surface with `live:false` so the view shows what is declared.
export const collectDeployments = async (artifact: string, log: (message: string) => void): Promise<DeploymentView[]> => {
    if (!existsSync(artifact)) {
        return [];
    }
    const dir = dirname(artifact);
    loadEnvFile(dir);
    const graph = await readArtifact(artifact);
    const generated = await readGeneratedSecrets(dir);

    const access = komodoAccess(graph, generated);
    const komodoUrl = access?.url ?? "";
    const liveIds = new Map<string, string>();
    if (access !== undefined) {
        try {
            const jwt = await komodoApi.login({ baseUrl: access.url, username: access.user, password: access.password });
            for (const item of await komodoApi.listDeployments({ baseUrl: access.url, jwt })) {
                liveIds.set(item.name, item.id);
            }
        } catch (error) {
            log(`komodo not reachable, showing desired config only: ${String(error)}`);
        }
    }

    return Object.values(graph.resources)
        .filter((resource) => resource.type === "deployment")
        .map((node) => {
            const registry = asString(node.inputs["registry"]) ?? "";
            const owner = asString(node.inputs["owner"]) ?? "";
            const repoName = asString(node.inputs["repoName"]) ?? "";
            const tag = asString(node.inputs["tag"]) ?? "";
            const domain = asString(node.inputs["domain"]);
            const port = asNumber(node.inputs["port"]);
            const komodoId = liveIds.get(node.id);
            return {
                name: node.id,
                image: `${registry}/${owner}/${repoName}:${tag}`,
                tag,
                ...(domain !== undefined ? { domain, url: `https://${domain}` } : {}),
                ...(port !== undefined ? { port } : {}),
                env: envOf(node.inputs["env"]),
                live: komodoId !== undefined,
                komodoUrl,
                ...(komodoId !== undefined && komodoUrl !== "" ? { komodoDeploymentUrl: `${komodoUrl}/deployment/${komodoId}` } : {}),
            };
        });
};
