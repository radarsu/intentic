import type { Capability } from "./needs.js";

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

// Today's fixed stack as the default catalog: one option per capability. Adding Gitlab later is a pure
// data change — a second option providing source-control + docker-registry — which makes
// generateCandidates yield more than one desired-state artifact.
const options: readonly Option[] = [
    { id: "forgejo", provides: ["source-control", "docker-registry"] },
    { id: "komodo", provides: ["infra-control"] },
    { id: "ssh-linux", provides: ["deployment-target"] },
    { id: "cloudflare-tunnel", provides: ["domain"] },
];

export const defaultCatalog: Catalog = Object.freeze({
    optionsFor: (capability: Capability): readonly Option[] => options.filter((option) => option.provides.includes(capability)),
});
