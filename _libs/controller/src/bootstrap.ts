import type { ApplyOutcome, Providers, ReadinessProbe } from "@puristic/deploy-engine";
import { apply } from "@puristic/deploy-engine";
import type { ForgejoApi, SshExecutor } from "@puristic/deploy-providers";
import { createForgejoProvider, forgejoApi, sshExecutor } from "@puristic/deploy-providers";
import type { ControlPlaneConfig } from "./control-plane.js";
import { buildControlPlaneGraph, controlGitId, intentRepoId, targetRepoId } from "./control-plane.js";
import { createControlRepoProvider } from "./control-repo.js";

export interface BootstrapOutcome {
    readonly forgejoUrl: string;
    readonly forgejoInternalUrl: string;
    readonly intentRepoCloneUrl: string;
    readonly targetRepoCloneUrl: string;
}

export interface BootstrapDeps {
    readonly ssh?: SshExecutor;
    readonly forgejo?: ForgejoApi;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly probe?: ReadinessProbe;
    readonly log?: (message: string) => void;
}

const requireOutput = (outcome: ApplyOutcome, id: string, key: string): string => {
    const value = outcome.outputs[id]?.[key];
    if (typeof value !== "string") {
        throw new Error(`control-plane bootstrap produced no string output "${key}" for "${id}"`);
    }
    return value;
};

// Stand up the control plane and create the intent + reconciliation-target repos. Routes through the
// engine over idempotent providers, so a second bootstrap is all-noop — this is what makes the
// chicken-and-egg of the control plane safe: it converges itself the same way everything else does.
export const bootstrap = async (config: ControlPlaneConfig, deps: BootstrapDeps = {}): Promise<BootstrapOutcome> => {
    const providers: Providers = {
        forgejo: createForgejoProvider(deps.ssh ?? sshExecutor),
        "control-repo": createControlRepoProvider(deps.forgejo ?? forgejoApi),
    };
    const outcome = await apply(buildControlPlaneGraph(config), {
        providers,
        ...(deps.env !== undefined ? { env: deps.env } : {}),
        ...(deps.probe !== undefined ? { probe: deps.probe } : {}),
        ...(deps.log !== undefined ? { log: deps.log } : {}),
    });
    return {
        forgejoUrl: requireOutput(outcome, controlGitId, "url"),
        forgejoInternalUrl: requireOutput(outcome, controlGitId, "internalUrl"),
        intentRepoCloneUrl: requireOutput(outcome, intentRepoId, "cloneUrl"),
        targetRepoCloneUrl: requireOutput(outcome, targetRepoId, "cloneUrl"),
    };
};
