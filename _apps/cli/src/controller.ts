import type { Providers, ReadinessProbe } from "@intentic/engine";
import { reconcile } from "@intentic/engine";
import type { ForgejoApi, SshExecutor } from "@intentic/providers";
import { createProviders, forgejoApi } from "@intentic/providers";
import type { Candidate } from "@intentic/resolvers";
import { adminUsername, choose } from "@intentic/resolvers";
import { bootstrap } from "./bootstrap.js";
import type { ControlPlaneConfig } from "./control-plane.js";
import { controlBranch, intentRepoName, targetRepoName } from "./control-plane.js";

// The file a user pushes into the intent repo, the chosen artifact committed back to the target repo, and
// the execution record alongside it.
export const configFileName = "deploy.config.ts";
export const artifactFileName = "reconciliation-target.json";
export const statusFileName = "status.json";

const DEFAULT_POLL_INTERVAL_MS = 15_000;
const DEFAULT_MAX_ITERATIONS = 5;

export interface ControllerDeps {
    readonly config: ControlPlaneConfig;
    readonly forgejo?: ForgejoApi;
    readonly ssh?: SshExecutor;
    // App-plane providers used to execute the chosen artifact; defaults to the real provider map.
    readonly providers?: Providers;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly probe?: ReadinessProbe;
    readonly log?: (message: string) => void;
    readonly pollIntervalMs?: number;
    readonly maxIterations?: number;
    // Seam: evaluate a pushed deploy.config.ts source into candidate artifacts. Injected because
    // evaluating TypeScript is environment-specific (dynamic import vs. a sandbox).
    readonly evaluateIntent: (source: string) => Promise<readonly Candidate[]>;
}

interface Access {
    readonly baseUrl: string;
    readonly user: string;
    readonly password: string;
}

export interface CycleParams {
    readonly forgejo: ForgejoApi;
    readonly access: Access;
    readonly providers: Providers;
    readonly evaluateIntent: (source: string) => Promise<readonly Candidate[]>;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly probe?: ReadinessProbe;
    readonly log: (message: string) => void;
    readonly maxIterations: number;
    readonly lastSha: string | undefined;
}

// One controller cycle: if the intent repo has a new commit, compute candidates, auto-pick one, store it
// in the reconciliation-target repo, execute it until state reads true, and record the outcome. Returns
// the commit it processed (or the unchanged last sha when there is nothing new), so the caller advances.
export const runCycle = async (params: CycleParams): Promise<string | undefined> => {
    const { forgejo, access, log } = params;
    const intent = { ...access, owner: adminUsername, name: intentRepoName, branch: controlBranch };
    const sha = await forgejo.latestCommit(intent);
    if (sha === undefined || sha === params.lastSha) {
        return params.lastSha;
    }
    log(`intent: new commit ${sha}`);

    const source = await forgejo.readFile({ ...intent, path: configFileName });
    if (source === undefined) {
        log(`intent: ${configFileName} missing in commit ${sha}; skipping`);
        return sha;
    }

    const candidates = await params.evaluateIntent(source);
    const chosen = choose(candidates);
    log(`intent ${sha}: chose candidate "${chosen.key}" of ${candidates.length}`);

    const target = { ...access, owner: adminUsername, name: targetRepoName, branch: controlBranch };
    await forgejo.commitFile({
        ...target,
        path: artifactFileName,
        content: JSON.stringify(chosen.graph, undefined, 4),
        message: `reconciliation target for intent ${sha}`,
    });

    const result = await reconcile(
        chosen.graph,
        {
            providers: params.providers,
            ...(params.env !== undefined ? { env: params.env } : {}),
            ...(params.probe !== undefined ? { probe: params.probe } : {}),
            log,
        },
        { maxIterations: params.maxIterations },
    );
    await forgejo.commitFile({
        ...target,
        path: statusFileName,
        content: JSON.stringify(
            { intent: sha, converged: result.converged, iterations: result.iterations, steps: result.outcome.steps },
            undefined,
            4,
        ),
        message: `status for intent ${sha}`,
    });
    log(`intent ${sha}: converged in ${result.iterations} iteration(s)`);
    return sha;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Long-running control loop: bootstrap the control plane, then poll the intent repo and run a cycle on
// every new push. A failing cycle is logged and the daemon survives — a bad push must not take the
// controller down (the inner reconcile already propagates within the cycle).
export const runController = async (deps: ControllerDeps): Promise<never> => {
    const log = deps.log ?? console.log;
    const env = deps.env ?? process.env;
    const forgejo = deps.forgejo ?? forgejoApi;
    const providers = deps.providers ?? createProviders();

    const boot = await bootstrap(deps.config, {
        ...(deps.ssh !== undefined ? { ssh: deps.ssh } : {}),
        ...(deps.probe !== undefined ? { probe: deps.probe } : {}),
        forgejo,
        env,
        log,
    });
    const password = env[deps.config.adminPassword.key];
    if (password === undefined) {
        throw new Error(`control-plane admin password env var "${deps.config.adminPassword.key}" is not set`);
    }
    const access: Access = { baseUrl: boot.forgejoInternalUrl, user: adminUsername, password };

    let lastSha: string | undefined;
    const interval = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    for (;;) {
        try {
            lastSha = await runCycle({
                forgejo,
                access,
                providers,
                evaluateIntent: deps.evaluateIntent,
                env,
                ...(deps.probe !== undefined ? { probe: deps.probe } : {}),
                log,
                maxIterations: deps.maxIterations ?? DEFAULT_MAX_ITERATIONS,
                lastSha,
            });
        } catch (error) {
            log(`controller cycle failed: ${String(error)}`);
        }
        await sleep(interval);
    }
};
