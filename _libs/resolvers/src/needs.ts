import type { IntentSet } from "./intent.js";
import { CLOUDFLARE_ID, HOST_ID } from "./inventory.js";

// The abstract capabilities an intent requires, independent of which concrete option fills them. The
// resolver derives these from apps; the catalog maps each to the options that can satisfy it.
export type Capability = "source-control" | "docker-registry" | "infra-control" | "deployment-target" | "domain";

// One required capability at one scope. Control-plane capabilities are host-scoped (one git/CI/deploy
// stack per host); domain is cloud-scoped (one tunnel per Cloudflare account).
export interface Need {
    readonly capability: Capability;
    readonly scope: string;
}

// The control-plane capabilities the host running the apps must provide. Domain is derived separately,
// scoped to the Cloudflare the apps are exposed through.
const hostCapabilities: readonly Capability[] = ["source-control", "docker-registry", "infra-control", "deployment-target"];

// What an intent requires: any apps mean the single implicit host needs the full control-plane stack and
// the single implicit Cloudflare needs a domain. Host needs come before the domain need so the candidate
// graphs derived from them keep a stable shape.
export const deriveNeeds = (intent: IntentSet): Need[] => {
    if (intent.apps.length === 0) {
        return [];
    }
    const needs: Need[] = hostCapabilities.map((capability) => ({ capability, scope: HOST_ID }));
    needs.push({ capability: "domain", scope: CLOUDFLARE_ID });
    return needs;
};

export const needKey = (need: Need): string => `${need.capability}:${need.scope}`;
