import { writeFile } from "node:fs/promises";
import type { DesiredStateGraph, SecretSource, SerializedValue } from "@intentic/graph";
import { renderTemplate } from "../lib/templates.js";

// Read the source + env-var key behind a serialized secret input ({ $secret: { source, key } }), or undefined
// if `value` is not a secret node. Enumeration/display only — never reads the secret VALUE (that is the
// engine's resolve-inputs path).
export const secretRef = (value: SerializedValue | undefined): { readonly source: SecretSource; readonly key: string } | undefined => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }
    const secret = (value as { $secret?: { source?: unknown; key?: unknown } }).$secret;
    if (typeof secret !== "object" || secret === null) {
        return undefined;
    }
    const { source, key } = secret;
    if (typeof key !== "string" || (source !== "env" && source !== "generated")) {
        return undefined;
    }
    return { source, key };
};

// Every secret the resolved graph requires, split by who provides it: `env` — the user supplies it in the
// environment; `generated` — intentic creates and persists it. Secrets nest (an app environment's `env` map,
// the platform nodes the resolver injects), so walk inputs recursively; the resolved graph is the only
// complete source (a hand-written list drifts). Each bucket is de-duplicated and sorted. A key declared under
// BOTH sources is a resolver bug — surface it here rather than half-generate it at apply time.
export const collectSecrets = (graph: DesiredStateGraph): { readonly env: string[]; readonly generated: string[] } => {
    const sources = new Map<string, SecretSource>();
    const walk = (value: SerializedValue): void => {
        if (Array.isArray(value)) {
            value.forEach(walk);
            return;
        }
        const ref = secretRef(value);
        if (ref !== undefined) {
            const seen = sources.get(ref.key);
            if (seen !== undefined && seen !== ref.source) {
                throw new Error(`secret "${ref.key}" is declared as both ${seen} and ${ref.source}`);
            }
            sources.set(ref.key, ref.source);
            return;
        }
        if (typeof value === "object" && value !== null) {
            Object.values(value).forEach(walk);
        }
    };
    for (const node of Object.values(graph.resources)) {
        Object.values(node.inputs).forEach(walk);
    }
    const bucket = (source: SecretSource): string[] =>
        [...sources]
            .filter(([, s]) => s === source)
            .map(([key]) => key)
            .sort();
    return { env: bucket("env"), generated: bucket("generated") };
};

// The `.env.example` beside the artifact: one `KEY=` line per user-supplied secret, with a header so a user
// knows to copy it to `.env` and fill each value in. Valid for `process.loadEnvFile` (# comments ok).
export const writeEnvExample = async (path: string, keys: readonly string[]): Promise<void> => {
    await writeFile(path, renderTemplate("env-example", { keys }));
};
