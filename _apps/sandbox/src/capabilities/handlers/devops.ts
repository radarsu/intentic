import { existsSync } from "node:fs";
import type { CapabilityHandler } from "../capability.js";

// DevOps: scaffold the intent + desired-state repos and make them provisionable. This is the capability that
// turns an empty sandbox into an infra-capable one — the Infra UI plus the service/integration capabilities all
// depend on it. No `remove`: deleting the repos would destroy the user's declared infrastructure.
export const devopsHandler: CapabilityHandler = {
    apply: async function* (ctx) {
        if (existsSync(ctx.workspace.repos.intent)) {
            yield { kind: "log", message: "Intent repo already present." };
        } else {
            yield { kind: "log", message: "Scaffolding intent + desired-state repos…" };
            await ctx.scaffoldNeutralLedger();
        }
        yield { kind: "log", message: "Installing provisioning dependencies (this can take a minute)…" };
        await ctx.ensureIntentInstallable();
        await ctx.ensureDeployTarget();
        yield { kind: "log", message: "DevOps ready — infrastructure is now available." };
    },
    status: async (ctx) =>
        existsSync(ctx.workspace.repos.intent) && existsSync(ctx.workspace.repos["desired-state"]) ? { state: "active" } : { state: "inactive" },
};
