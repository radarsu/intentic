import { z } from "zod";

/* The platform-owned region of an intent's deploy.config.ts. Everything between the markers is regenerated
 * wholesale from the structured inventory entries, so the UI can edit the file deterministically; the user's
 * code outside the markers is never touched. The sandbox owns this now (the browser calls the daemon's
 * /inventory routes directly) — ported from the platform's api/deploy-config.ts.
 *
 * Two entry shapes live in the region: `backend` (i.have.<provider>(...) — host/cloudflare/github/stripe) and
 * `service` (i.want.service(...) — an authorable shared tool like SigNoz). A service references an existing
 * host + cloudflare binding by NAME, rendered as bare const references (`on: self`), and parsed back to those
 * names — the render→parse cycle must be lossless so repeated edits never mangle a user's services. */

// ---- Inventory wire contract. Duplicated from the platform's @app_/api-contract (a separate repo we can't
// import) — the daemon produces these and the browser validates them against the platform's matching schema,
// the same cross-repo-contract pattern as AgentEvent / IntenticLine. Keep the two in sync. ----
export const InventoryProviderSchema = z.enum(["host", "cloudflare", "github", "stripe"]);
export type InventoryProvider = z.infer<typeof InventoryProviderSchema>;
export const ServiceKindSchema = z.enum(["signoz"]);
export type ServiceKind = z.infer<typeof ServiceKindSchema>;
// Non-secret option values the user provides; secret options (sshKey, apiToken, apiKey) are emitted as env()
// references and never travel over the wire.
export const InventoryValuesSchema = z.record(z.string(), z.union([z.string(), z.number()]));
// `const <name>` binding in deploy.config.ts, so it must be a valid identifier.
const inventoryName = z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/);
export const BackendEntrySchema = z.object({
    kind: z.literal("backend"),
    provider: InventoryProviderSchema,
    name: z.string(),
    values: InventoryValuesSchema,
});
export const ServiceEntrySchema = z.object({
    kind: z.literal("service"),
    service: ServiceKindSchema,
    name: z.string(),
    values: InventoryValuesSchema,
    on: z.string(),
    expose: z.string(),
});
export const InventoryEntrySchema = z.discriminatedUnion("kind", [BackendEntrySchema, ServiceEntrySchema]);
export type InventoryEntry = z.infer<typeof InventoryEntrySchema>;
export const AddInventoryInputSchema = z.discriminatedUnion("kind", [
    BackendEntrySchema.extend({ name: inventoryName }),
    ServiceEntrySchema.extend({ name: inventoryName }),
]);
export type AddInventoryInput = z.infer<typeof AddInventoryInputSchema>;

// ---- managed-region parser/renderer ----

const BEGIN_TAG = `// <intentic>`;
const END_TAG = `// </intentic>`;
const BEGIN_MARKER = `${BEGIN_TAG} managed — do not edit by hand`;
const INDENT = `    `;

type ServiceEntry = Extract<InventoryEntry, { kind: `service` }>;

// How one option is emitted: from a provided value (string/number), or as an env() secret reference.
interface FieldSpec {
    readonly key: string;
    readonly source: "string" | "number" | "env";
    readonly envVar?: string;
}
interface ProviderSpec {
    readonly fields: readonly FieldSpec[];
}

// v1 assumes a single host + single cloudflare, matching the original scaffold's fixed env-var names.
const REGISTRY: Record<InventoryProvider, ProviderSpec> = {
    host: {
        fields: [
            { key: `address`, source: `string` },
            { key: `user`, source: `string` },
            { key: `port`, source: `number` },
            { key: `sshKey`, source: `env`, envVar: `HOST_SSH_KEY` },
        ],
    },
    cloudflare: {
        fields: [{ key: `apiToken`, source: `env`, envVar: `CLOUDFLARE_API_TOKEN` }],
    },
    github: {
        fields: [{ key: `token`, source: `env`, envVar: `GITHUB_TOKEN` }],
    },
    stripe: {
        fields: [{ key: `apiKey`, source: `env`, envVar: `STRIPE_API_KEY` }],
    },
};

// i.want.service field specs (beyond kind/on/expose, which are rendered structurally). SigNoz takes a domain.
const SERVICE_REGISTRY: Record<ServiceKind, ProviderSpec> = {
    signoz: { fields: [{ key: `domain`, source: `string` }] },
};

const renderOption = (entry: InventoryEntry, field: FieldSpec): string => {
    if (field.source === `env`) {
        return `${field.key}: env(${JSON.stringify(field.envVar ?? ``)})`;
    }
    const value = entry.values[field.key];
    if (field.source === `number`) {
        return `${field.key}: ${typeof value === `number` ? value : Number(value ?? 0)}`;
    }
    return `${field.key}: ${JSON.stringify(String(value ?? ``))}`;
};

const renderBackendEntry = (entry: Extract<InventoryEntry, { kind: `backend` }>): string => {
    const spec = REGISTRY[entry.provider];
    const options = spec.fields.map((field) => renderOption(entry, field)).join(`, `);
    return `${INDENT}const ${entry.name} = i.have.${entry.provider}(${JSON.stringify(entry.name)}, { ${options} });`;
};

// i.want.service references its host + cloudflare bindings by name (bare identifiers — NOT quoted), so the
// generated TS wires the same const bindings the backend entries declare.
const renderServiceEntry = (entry: ServiceEntry): string => {
    const spec = SERVICE_REGISTRY[entry.service];
    const options = [
        `kind: ${JSON.stringify(entry.service)}`,
        `on: ${entry.on}`,
        `expose: ${entry.expose}`,
        ...spec.fields.map((field) => renderOption(entry, field)),
    ].join(`, `);
    return `${INDENT}const ${entry.name} = i.want.service(${JSON.stringify(entry.name)}, { ${options} });`;
};

const renderEntry = (entry: InventoryEntry): string => (entry.kind === `service` ? renderServiceEntry(entry) : renderBackendEntry(entry));

const renderRegion = (entries: readonly InventoryEntry[]): string =>
    [`${INDENT}${BEGIN_MARKER}`, ...entries.map(renderEntry), `${INDENT}${END_TAG}`].join(`\n`);

// Rewrites the managed region in `src` to exactly `entries`. Replaces the existing region when present; otherwise
// inserts one just inside the defineIntent callback body. Throws when neither is possible (no defineIntent found).
export const writeManagedRegion = (src: string, entries: readonly InventoryEntry[]): string => {
    const lines = src.split(`\n`);
    const begin = lines.findIndex((line) => line.trim().startsWith(BEGIN_TAG));
    const end = lines.findIndex((line) => line.trim().startsWith(END_TAG));
    const region = renderRegion(entries).split(`\n`);

    if (begin !== -1 && end !== -1 && end > begin) {
        return [...lines.slice(0, begin), ...region, ...lines.slice(end + 1)].join(`\n`);
    }

    const open = lines.findIndex((line) => /defineIntent\(\s*\(?\s*\w*\s*\)?\s*=>\s*\{/.test(line));
    if (open === -1) {
        throw new Error(`deploy.config.ts has no defineIntent((i) => { … }) body to insert the managed region into.`);
    }
    return [...lines.slice(0, open + 1), ...region, ``, ...lines.slice(open + 1)].join(`\n`);
};

// Best-effort parse of the option object source into display values: `key: "string"` and `key: 123`. env(...)
// references (secrets) and bare-identifier references (on/expose) are intentionally skipped — not display values.
const parseValues = (optionsSrc: string): Record<string, string | number> => {
    const values: Record<string, string | number> = {};
    for (const match of optionsSrc.matchAll(/(\w+)\s*:\s*"([^"]*)"/g)) {
        const key = match[1];
        const value = match[2];
        if (key !== undefined && value !== undefined) {
            values[key] = value;
        }
    }
    for (const match of optionsSrc.matchAll(/(\w+)\s*:\s*(-?\d+)\b/g)) {
        const key = match[1];
        const value = match[2];
        if (key !== undefined && value !== undefined && !(key in values)) {
            values[key] = Number(value);
        }
    }
    return values;
};

const KNOWN_PROVIDERS = new Set<string>(Object.keys(REGISTRY));
const KNOWN_SERVICES = new Set<string>(Object.keys(SERVICE_REGISTRY));

// Pick only the known display fields of a service kind out of the parsed values (drops `kind`, which the
// parser also captures as a string value).
const serviceValues = (kind: ServiceKind, all: Record<string, string | number>): Record<string, string | number> => {
    const values: Record<string, string | number> = {};
    for (const field of SERVICE_REGISTRY[kind].fields) {
        if (field.key in all) {
            values[field.key] = all[field.key] as string | number;
        }
    }
    return values;
};

// Parses the i.have.* and i.want.service declarations inside the managed region into structured entries.
// Unknown providers/services (anything not in the registries) are skipped — the inventory only surfaces what
// the platform knows how to manage, so a hand-authored declaration we don't model is left untouched.
export const readManagedRegion = (src: string): InventoryEntry[] => {
    const lines = src.split(`\n`);
    const begin = lines.findIndex((line) => line.trim().startsWith(BEGIN_TAG));
    const end = lines.findIndex((line) => line.trim().startsWith(END_TAG));
    if (begin === -1 || end === -1 || end <= begin) {
        return [];
    }

    const entries: InventoryEntry[] = [];
    for (const line of lines.slice(begin + 1, end)) {
        // service: i.want.service("name", { kind, on, expose, ... }) — on/expose are bare const references.
        const serviceMatch = /i\.want\.service\(\s*"([^"]+)"\s*,\s*\{(.*)\}\s*\)/.exec(line);
        if (serviceMatch) {
            const name = serviceMatch[1];
            const optionsSrc = serviceMatch[2];
            const kind = /\bkind\s*:\s*"([^"]+)"/.exec(optionsSrc ?? ``)?.[1];
            const on = /\bon\s*:\s*([a-zA-Z_]\w*)/.exec(optionsSrc ?? ``)?.[1];
            const expose = /\bexpose\s*:\s*([a-zA-Z_]\w*)/.exec(optionsSrc ?? ``)?.[1];
            if (
                name !== undefined &&
                optionsSrc !== undefined &&
                kind !== undefined &&
                KNOWN_SERVICES.has(kind) &&
                on !== undefined &&
                expose !== undefined
            ) {
                entries.push({
                    kind: `service`,
                    service: kind as ServiceKind,
                    name,
                    on,
                    expose,
                    values: serviceValues(kind as ServiceKind, parseValues(optionsSrc)),
                });
            }
            continue;
        }
        // backend: i.have.<provider>("name", { ... }).
        const match = /i\.have\.(\w+)\(\s*"([^"]+)"\s*,\s*\{(.*)\}\s*\)/.exec(line);
        const provider = match?.[1];
        const name = match?.[2];
        const optionsSrc = match?.[3];
        if (provider === undefined || name === undefined || optionsSrc === undefined || !KNOWN_PROVIDERS.has(provider)) {
            continue;
        }
        entries.push({ kind: `backend`, provider: provider as InventoryProvider, name, values: parseValues(optionsSrc) });
    }
    return entries;
};

// A fresh deploy.config.ts containing only the managed region — the base when writing inventory into a repo
// that has no config yet.
export const scaffoldDeployConfig = (entries: readonly InventoryEntry[]): string =>
    [
        `import { env } from "@intentic/graph";`,
        `import { defineIntent } from "@intentic/sdk";`,
        ``,
        `export const intent = defineIntent((i) => {`,
        renderRegion(entries),
        ``,
        `});`,
        ``,
    ].join(`\n`);
