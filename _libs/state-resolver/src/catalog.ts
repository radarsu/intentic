import type { Capability } from "@intentic/need-resolver";

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

// Today's fixed stack as the default catalog: exactly one option per capability. The state resolver makes
// no choice, so the catalog stays single-option-per-capability; supporting an alternative (e.g. Gitlab for
// source-control + docker-registry) would mean the intent itself selecting between them.
const options: readonly Option[] = [
    { id: "forgejo", provides: ["source-control", "docker-registry"] },
    { id: "komodo", provides: ["infra-control"] },
    { id: "ssh-linux", provides: ["deployment-target"] },
    { id: "cloudflare-tunnel", provides: ["domain"] },
];

export const defaultCatalog: Catalog = Object.freeze({
    optionsFor: (capability: Capability): readonly Option[] => options.filter((option) => option.provides.includes(capability)),
});
