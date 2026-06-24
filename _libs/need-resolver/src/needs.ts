import type { IntentSet } from "./intent.js";

// The abstract capabilities an intent requires, independent of which concrete option fills them. The
// need resolver derives these from apps; the catalog maps each to the options that can satisfy it.
export type Capability = "source-control" | "docker-registry" | "infra-control" | "deployment-target" | "domain";

// Which plane a capability belongs to. Control = the deploy machinery (git, registry, orchestration);
// application = what serves the app (its runtime target and public domain). Orthogonal to scope below.
export type Plane = "control" | "application";

// One required capability at one scope, on one plane. Scope is *where it runs* — control capabilities and
// the deployment target are host-scoped (one git/CI/deploy stack per host); domain is cloud-scoped (one
// tunnel per Cloudflare account). Plane is *its role* — note deployment-target is host-scoped but lives on
// the application plane.
export interface Need {
    readonly capability: Capability;
    readonly scope: string;
    readonly plane: Plane;
}

const planeOf: Readonly<Record<Capability, Plane>> = {
    "source-control": "control",
    "docker-registry": "control",
    "infra-control": "control",
    "deployment-target": "application",
    domain: "application",
};

// The host-scoped capabilities the host running the apps must provide: the control-plane stack plus the
// application-plane deployment target. Domain is derived separately, scoped to the Cloudflare the apps are
// exposed through.
const hostCapabilities: readonly Capability[] = ["source-control", "docker-registry", "infra-control", "deployment-target"];

// What an intent requires: any apps mean the authored host needs its host capabilities and the authored
// Cloudflare needs a domain, each scoped to its declared id. Host needs come before the domain need so the
// desired state derived from them keeps a stable shape.
export const resolveNeeds = (intent: IntentSet): Need[] => {
    if (intent.apps.length === 0) {
        return [];
    }
    const host = intent.host;
    const cloudflare = intent.cloudflare;
    if (host === undefined || cloudflare === undefined) {
        throw new Error("intent declares apps but no host/Cloudflare; declare them with i.have.host and i.have.cloudflare");
    }
    const needs: Need[] = hostCapabilities.map((capability) => ({ capability, scope: host.id, plane: planeOf[capability] }));
    needs.push({ capability: "domain", scope: cloudflare.id, plane: planeOf.domain });
    return needs;
};

export const needKey = (need: Need): string => `${need.capability}:${need.scope}`;
