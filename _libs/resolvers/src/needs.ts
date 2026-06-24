import type { IntentSet } from "./intent.js";

// The abstract capabilities an intent requires, independent of which concrete option fills them. The
// resolver derives these from apps; the catalog maps each to the options that can satisfy it.
export type Capability = "source-control" | "docker-registry" | "infra-control" | "deployment-target" | "domain";

// One required capability at one scope. Control-plane capabilities are host-scoped (one git/CI/deploy
// stack per host); domain is cloud-scoped (one tunnel per Cloudflare account).
export interface Need {
    readonly capability: Capability;
    readonly scope: string;
}

// The control-plane capabilities every host running an app must provide. Domain is derived separately,
// scoped to the Cloudflare the app exposes through.
const hostCapabilities: readonly Capability[] = ["source-control", "docker-registry", "infra-control", "deployment-target"];

// What an intent requires: each distinct host an app targets needs the full control-plane stack; each
// distinct Cloudflare an app exposes through needs a domain. Host needs come before domain needs so the
// candidate graphs derived from them keep a stable shape.
export const deriveNeeds = (intent: IntentSet): Need[] => {
    const needs: Need[] = [];
    const seen = new Set<string>();
    const add = (capability: Capability, scope: string): void => {
        const key = `${capability}:${scope}`;
        if (seen.has(key)) {
            return;
        }
        seen.add(key);
        needs.push({ capability, scope });
    };
    for (const app of intent.apps) {
        for (const capability of hostCapabilities) {
            add(capability, app.on);
        }
    }
    for (const app of intent.apps) {
        add("domain", app.expose);
    }
    return needs;
};

export const needKey = (need: Need): string => `${need.capability}:${need.scope}`;
