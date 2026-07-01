import type { Capability, CapabilityKind, CapabilityStatus, IntenticLine } from "@intentic/sandbox-contract";
import { readManagedRegion } from "@intentic/scaffold";
import type { Services } from "../composition.js";
import { type ConfigStore, createConfigStore } from "../inventory/config-store.js";
import { ensureDeployTarget } from "../inventory/deploy-target.js";
import { ensureIntentInstallable } from "../workspace/ensure-intent.js";
import { scaffoldNeutralLedger } from "../workspace/scaffold-ledger.js";
import type { CapabilitiesStore } from "./capabilities-store.js";

// The narrow slice of the daemon a capability handler may touch — deliberately no agent/auth/sessions surface.
// The three scaffolder closures wrap the existing whole-Services helpers so a handler can trigger them without
// holding Services itself.
export interface CapabilityCtx {
    readonly logger: Services["logger"];
    readonly workspace: Services["workspace"];
    readonly selfHost: Services["selfHost"];
    readonly git: Services["git"];
    readonly files: Services["files"];
    readonly intentic: Services["intentic"];
    readonly config: ConfigStore;
    readonly capabilities: CapabilitiesStore;
    readonly scaffoldNeutralLedger: () => Promise<void>;
    readonly ensureIntentInstallable: () => Promise<void>;
    readonly ensureDeployTarget: () => Promise<void>;
}

// A capability kind's behaviour. `apply` is idempotent and streams progress (mcp/integration emit one frame;
// devops/service stream real work). `status` is a fast, non-blocking probe. A kind with no `remove` can't be
// torn down (devops). `requires` lists kinds that must already be active (checked at the route before apply).
export interface CapabilityHandler {
    readonly requires?: readonly CapabilityKind[];
    readonly apply: (ctx: CapabilityCtx, id: string, config: unknown) => AsyncGenerator<IntenticLine>;
    readonly status: (ctx: CapabilityCtx, id: string, config: unknown) => Promise<CapabilityStatus>;
    readonly remove?: (ctx: CapabilityCtx, id: string, config: unknown) => Promise<void>;
}

// Build the handler context from the full Services, wrapping the existing scaffolders as zero-arg closures.
export const capabilityCtx = (services: Services): CapabilityCtx => {
    const config = createConfigStore(services);
    return {
        logger: services.logger,
        workspace: services.workspace,
        selfHost: services.selfHost,
        git: services.git,
        files: services.files,
        intentic: services.intentic,
        config,
        capabilities: services.capabilities,
        scaffoldNeutralLedger: () => scaffoldNeutralLedger(services),
        ensureIntentInstallable: () => ensureIntentInstallable(services),
        ensureDeployTarget: async () => {
            const content = await config.read();
            await ensureDeployTarget(services, config, content, readManagedRegion(content));
        },
    };
};

// Non-secret echo of a capability's config for the list summary (an mcp token becomes hasToken).
export const echoConfig = (capability: Capability): Record<string, string | number | boolean> => {
    switch (capability.kind) {
        case "mcp":
            return { url: capability.config.url, hasToken: capability.config.token !== undefined };
        case "service":
            return {
                service: capability.config.service,
                domain: capability.config.domain,
                on: capability.config.on,
                expose: capability.config.expose,
            };
        case "integration":
            return { provider: capability.config.provider };
        case "devops":
            return {};
    }
};
