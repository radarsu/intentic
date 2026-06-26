import type { Capability, IntentSet } from "@intentic/need-resolver";

// A concrete way to satisfy one or more capabilities. One option can fill several needs at once — Forgejo
// (the "Gitea" option) provides both source control and a Docker registry — which couples those needs to
// the same choice.
export interface Option {
    readonly id: string;
    readonly provides: readonly Capability[];
}

export interface Catalog {
    optionsFor(capability: Capability): readonly Option[];
}

// The Forgejo+Komodo stack: self-hosted git, CI, registry, and deploy orchestration. Default when no
// i.have.github is declared.
const forgejoOptions: readonly Option[] = [
    { id: "forgejo", provides: ["source-control", "docker-registry"] },
    { id: "komodo", provides: ["infra-control"] },
    { id: "ssh-linux", provides: ["deployment-target"] },
    { id: "cloudflare-tunnel", provides: ["domain"] },
];

// The GitHub stack: hosted git + CI + registry (GHCR), with direct SSH deployment (no Komodo). Selected
// when i.have.github is declared.
const githubOptions: readonly Option[] = [
    { id: "github", provides: ["source-control", "docker-registry"] },
    { id: "github-actions", provides: ["infra-control"] },
    { id: "ssh-linux", provides: ["deployment-target"] },
    { id: "cloudflare-tunnel", provides: ["domain"] },
];

const makeCatalog = (options: readonly Option[]): Catalog =>
    Object.freeze({ optionsFor: (capability: Capability): readonly Option[] => options.filter((option) => option.provides.includes(capability)) });

export const forgejoCatalog: Catalog = makeCatalog(forgejoOptions);
export const githubCatalog: Catalog = makeCatalog(githubOptions);

// Select the catalog based on the intent: if i.have.github is declared, all apps use the GitHub stack;
// otherwise they use the self-hosted Forgejo+Komodo stack.
export const catalogFor = (intent: IntentSet): Catalog => (intent.github !== undefined ? githubCatalog : forgejoCatalog);
