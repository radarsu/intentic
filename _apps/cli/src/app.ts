import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applyMoves, createStore, type PruneOutcome, plan, prune, reconcile, resolveInputs, rewriteGraphForMoves } from "@intentic/engine";
import type { DesiredStateGraph } from "@intentic/graph";
import {
    createProviders,
    createSshExecutor,
    createSshProbe,
    forgejoApi,
    hostTarget,
    type RestoreScope,
    restoreBackup,
    type SshExecutor,
} from "@intentic/providers";
import { resolveState } from "@intentic/state-resolver";
import type { CommandContext } from "@stricli/core";
import { buildApplication, buildCommand, buildRouteMap, numberParser, text_en } from "@stricli/core";
import { collectAccess, formatAccessSummary, writeAccessFile } from "./access.js";
import { adoptRepos } from "./adopt.js";
import {
    GIT_TOKEN_ENV,
    GIT_TOKEN_SECRET,
    GIT_USER_SECRET,
    type PipelineInputs,
    setRepoSecrets,
    writeControlPlaneWorkflows,
} from "./adopt-pipelines.js";
import { acquireApplyLock } from "./apply-lock.js";
import {
    ACCESS_FILE,
    ARTIFACT_FILE,
    ARTIFACT_PATH,
    CONFIG_FILE,
    CONFIG_PATH,
    ENV_FILE,
    INTENT_DIR,
    LAST_APPLIED_FILE,
    loadEnvFile,
    readArtifact,
    STATUS_FILE,
    TARGET_DIR,
    writeArtifact,
    writeStatus,
} from "./artifact.js";
import { forgejoIdentity, syncControlPlaneSecrets } from "./control-plane-sync.js";
import { collectDeployments } from "./deployments.js";
import { ensureGeneratedSecrets, readGeneratedSecrets } from "./generated-secrets.js";
import { scaffold } from "./init.js";
import { createKnownHostsStore } from "./known-hosts.js";
import { detectHostMoves, migrateHosts } from "./migrate.js";
import { createOutput, outputMode } from "./output.js";
import { discoverZone, loadIntent } from "./resolve.js";
import { createSandboxTunnel } from "./sandbox-tunnel.js";
import { createHostSecretStore, createLayeredSecretStore, createLocalSecretStore, type SecretStore } from "./secret-store.js";
import { collectSecrets, writeEnvExample } from "./secrets.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const DEFAULT_MAX_ITERATIONS = 5;

// The generated secrets (Forgejo/Komodo admin passwords) are control-plane secrets whose authoritative home is
// the control-plane host — the host the Forgejo node runs on (its `server` ref). Anchoring there lets every
// operator share one value instead of minting its own laptop-local one (which would leave whoever didn't
// bootstrap unable to authenticate). The host node's inputs are pure SSH creds, so they resolve before the
// generated secrets exist — resolving the Forgejo node itself would need those very secrets. Falls back to the
// local cache alone when there is no Forgejo node or its host can't be found. `backfill` reconciles the layers
// (promote a locally-minted value to the host, mirror the host value back to a fresh operator's local cache);
// it is OFF for read-only commands so they never mutate a store.
const generatedSecretStore = (
    graph: DesiredStateGraph,
    dir: string,
    ssh: SshExecutor,
    backfill: boolean,
    log: (message: string) => void,
): SecretStore => {
    const local = createLocalSecretStore(dir);
    const forgejo = Object.values(graph.resources).find((node) => node.type === "forgejo");
    const serverRef = forgejo?.inputs["server"];
    const hostId =
        typeof serverRef === "object" && serverRef !== null && "$ref" in serverRef ? (serverRef as { readonly $ref: string }).$ref : undefined;
    const hostNode = hostId !== undefined ? graph.resources[hostId] : undefined;
    if (hostNode === undefined) {
        return local;
    }
    const target = hostTarget(resolveInputs(hostNode.inputs, createStore(), process.env, { lenient: false }));
    return createLayeredSecretStore([createHostSecretStore(target, ssh), local], { backfill, log });
};

const init = buildCommand<{ dir?: string; link: boolean; app?: string; selfHost: boolean; zone?: string }>({
    docs: { brief: "Scaffold local intent, desired-state, and app git repos" },
    parameters: {
        flags: {
            dir: { kind: "parsed", parse: String, optional: true, brief: "Directory to scaffold in (default: .)" },
            link: { kind: "boolean", brief: "Link @intentic/* to this monorepo's _libs for local development against unpublished packages" },
            app: { kind: "parsed", parse: String, optional: true, brief: "Clone this git URL as the app repo instead of scaffolding a starter app" },
            selfHost: { kind: "boolean", brief: "Scaffold the example app onto the auto-registered `self` deploy target (this machine) instead of a placeholder remote host" },
            zone: { kind: "parsed", parse: String, optional: true, brief: "Cloudflare zone for the scaffolded app's domain (app.<zone>); used with --self-host" },
        },
    },
    async func(this: CommandContext, flags: { dir?: string; link: boolean; app?: string; selfHost: boolean; zone?: string }) {
        const out = createOutput(this.process.stdout, outputMode(process.env));
        const { intentDir, targetDir, appDir } = await scaffold(flags.dir ?? ".", version, flags.link, flags.app, flags.selfHost, flags.zone);
        out.text(`initialized ${intentDir} (with ${CONFIG_FILE}), ${targetDir}, and ${appDir}`);
        out.result({ intentDir, targetDir, appDir });
    },
});

interface ResolveFlags {
    readonly config?: string;
    readonly out?: string;
    readonly syncControlPlane: boolean;
}

const resolveCommand = buildCommand<ResolveFlags>({
    docs: { brief: "Resolve a deploy.config.ts into the desired-state artifact" },
    parameters: {
        flags: {
            config: { kind: "parsed", parse: String, optional: true, brief: `Path to the intent config (default: ${CONFIG_PATH})` },
            out: { kind: "parsed", parse: String, optional: true, brief: `Path to write the artifact (default: ${ARTIFACT_PATH})` },
            syncControlPlane: {
                kind: "boolean",
                brief: "Push newly-required generated secrets into Forgejo and regenerate apply.yaml (run by the resolve pipeline post-adopt; needs GIT_TOKEN)",
            },
        },
    },
    async func(this: CommandContext, flags: ResolveFlags) {
        const out = createOutput(this.process.stdout, outputMode(process.env));
        const intent = await loadIntent(flags.config ?? CONFIG_PATH);
        const artifactOut = flags.out ?? ARTIFACT_PATH;
        const dir = dirname(artifactOut);
        // Capture the artifact being replaced BEFORE overwriting it — the control-plane sync diffs against it.
        const previousGraph = flags.syncControlPlane && existsSync(artifactOut) ? await readArtifact(artifactOut) : undefined;
        const zone = await discoverZone(intent, dir);
        const graph = resolveState(intent, zone);
        await writeArtifact(artifactOut, graph);
        const count = Object.keys(graph.resources).length;
        out.text(`resolved desired state (${count} resources) → ${artifactOut}`);
        if (zone !== undefined) {
            out.text(`discovered Cloudflare zone "${zone}" from the API token`);
        }
        // The resolver classifies each secret: `env` ones the user must supply (only knowable from the graph,
        // since the resolver injects platform secrets the authored config never names) → .env.example; the
        // `generated` ones (Forgejo/Komodo admin) intentic creates and owns itself → .secrets.json, written
        // here so it exists right after resolve (apply/plan reuse it).
        const { env: envKeys, generated } = collectSecrets(graph);
        if (envKeys.length > 0) {
            await writeEnvExample(join(dir, `${ENV_FILE}.example`), envKeys);
            out.text(`set these in ${ENV_FILE} before apply (see ${ENV_FILE}.example): ${envKeys.join(", ")}`);
        }
        if (generated.length > 0) {
            await ensureGeneratedSecrets(createLocalSecretStore(dir), generated, process.env);
            out.text(`generated these (stored in .secrets.json): ${generated.join(", ")}`);
        }
        let synced: { readonly pushed: readonly string[]; readonly newEnv: readonly string[] } | undefined;
        if (flags.syncControlPlane) {
            const password = process.env[GIT_TOKEN_ENV];
            if (password === undefined || password === "") {
                throw new Error(`set ${GIT_TOKEN_ENV} (the Forgejo admin password) to use --sync-control-plane`);
            }
            synced = await syncControlPlaneSecrets({
                previousGraph,
                newGraph: graph,
                env: process.env,
                dir,
                password,
                cliVersion: version,
                log: out.log,
            });
        }
        out.result({
            resources: count,
            ...(zone !== undefined ? { zone } : {}),
            envSecrets: envKeys,
            generatedSecrets: generated,
            ...(synced !== undefined ? { synced } : {}),
        });
    },
});

const planCommand = buildCommand<{ artifact?: string }>({
    docs: { brief: "Show what applying the artifact would create/update (read-only)" },
    parameters: {
        flags: { artifact: { kind: "parsed", parse: String, optional: true, brief: `Path to the artifact (default: ${ARTIFACT_PATH})` } },
    },
    async func(this: CommandContext, flags: { artifact?: string }) {
        const out = createOutput(this.process.stdout, outputMode(process.env));
        const artifact = flags.artifact ?? ARTIFACT_PATH;
        const dir = dirname(artifact);
        loadEnvFile(dir);
        const graph = await readArtifact(artifact);
        const ssh = createSshExecutor(createKnownHostsStore(dir));
        // Read-only command: read generated secrets from the host-authoritative store (no backfill — plan never
        // mutates a store), falling back to the local cache when the host is unreachable.
        await ensureGeneratedSecrets(generatedSecretStore(graph, dir, ssh, false, out.log), collectSecrets(graph).generated, process.env);
        const outcome = await plan(graph, { providers: createProviders({ ssh }), log: out.log, onEvent: out.onEvent });
        for (const step of outcome.steps) {
            out.text(`${step.action}\t${step.type}\t${step.id}${step.reason !== undefined ? `\t(${step.reason})` : ""}`);
        }
        out.result({ steps: outcome.steps, orphans: outcome.orphans });
    },
});

interface ApplyFlags {
    readonly artifact?: string;
    readonly maxIterations?: number;
    readonly previous?: string;
}

const apply = buildCommand<ApplyFlags>({
    docs: { brief: "Execute the desired-state artifact until state reads true" },
    parameters: {
        flags: {
            artifact: { kind: "parsed", parse: String, optional: true, brief: `Path to the artifact (default: ${ARTIFACT_PATH})` },
            maxIterations: {
                kind: "parsed",
                parse: numberParser,
                optional: true,
                brief: `Max reconcile iterations (default ${DEFAULT_MAX_ITERATIONS})`,
            },
            previous: {
                kind: "parsed",
                parse: String,
                optional: true,
                brief: "Path to the last successfully-applied artifact; resources absent from the new one are pruned after convergence",
            },
        },
    },
    async func(this: CommandContext, flags: ApplyFlags) {
        const out = createOutput(this.process.stdout, outputMode(process.env));
        const artifact = flags.artifact ?? ARTIFACT_PATH;
        const dir = dirname(artifact);
        loadEnvFile(dir);
        const graph = await readArtifact(artifact);
        const ssh = createSshExecutor(createKnownHostsStore(dir));
        // The last successfully-applied artifact: the shared baseline for host-migration detection (a host
        // whose address changed moved machines) and for prune below. A moved host is migrated before reconcile
        // so its data lands on the new machine; its old machine is also locked so no concurrent run mutates it.
        const previousPath = flags.previous ?? join(dir, LAST_APPLIED_FILE);
        const previous = existsSync(previousPath) ? await readArtifact(previousPath) : undefined;
        const hostMoves = previous !== undefined ? detectHostMoves(previous, graph) : [];
        // Readiness gates target host-internal urls (http://<internalIp>:<port>) reachable only from the host
        // itself, never from this CLI process. Build SSH probes from every host node in the graph so apply
        // gates on each host's own view; resolveInputs substitutes SSH_KEY secrets from the env loaded above.
        // The composite probe tries each host until one can reach the URL (the wrong host simply fails wget).
        const targets = Object.values(graph.resources)
            .filter((node) => node.type === "host")
            .map((node) => hostTarget(resolveInputs(node.inputs, createStore(), process.env, { lenient: false })));
        const probes = targets.map((target) => createSshProbe(target, ssh));
        const probe =
            probes.length === 0
                ? undefined
                : async (url: string, status: number): Promise<boolean> => {
                      for (const p of probes) {
                          if (await p(url, status)) {
                              return true;
                          }
                      }
                      return false;
                  };
        // Serialize this apply (and the prune that follows) against every host the graph touches, so a
        // concurrent run cannot interleave mutations. Released in `finally`; a hard crash leaves the lock to
        // free via its TTL. A SIGINT/SIGTERM handler releases on Ctrl-C before exiting.
        // Lock every host the graph touches PLUS the old machine of any moved host, so neither end of a
        // migration can be mutated by a concurrent run.
        const oldMoveTargets = hostMoves.map((move) =>
            hostTarget(resolveInputs(move.oldNode.inputs, createStore(), process.env, { lenient: false })),
        );
        const lock = await acquireApplyLock(ssh, [...targets, ...oldMoveTargets], { log: out.log });
        const onSignal = (): void => {
            void lock.release().finally(() => process.exit(130));
        };
        process.once("SIGINT", onSignal);
        process.once("SIGTERM", onSignal);
        try {
            // Mint/read generated secrets UNDER the lock, against the host-authoritative store (backfill on, so a
            // value minted locally before the host existed is promoted to it). Under the lock this is the only
            // run minting, so two operators can never bake divergent admin passwords into Forgejo/Komodo.
            await ensureGeneratedSecrets(generatedSecretStore(graph, dir, ssh, true, out.log), collectSecrets(graph).generated, process.env);
            // A host whose address changed moved machines: snapshot the old host and stream its data to the new
            // one BEFORE reconcile, so its services come up on the new machine atop migrated data, not an empty
            // disk. RESTIC_PASSWORD is in env now (ensureGeneratedSecrets above), so restore decrypts the repo.
            if (hostMoves.length > 0) {
                await migrateHosts(hostMoves, { next: graph, ssh, env: process.env, tmpDir: tmpdir(), log: out.log });
            }
            // Consume any authored renames BEFORE reconcile: re-stamp each moved resource in place so reconcile
            // sees it as already-present (a noop) instead of orphaning the old id and recreating the new one.
            const movedApplied = await applyMoves(graph, {
                providers: createProviders({ ssh }),
                log: out.log,
                onEvent: out.onEvent,
                env: process.env,
            });
            const result = await reconcile(
                graph,
                { providers: createProviders({ ssh }), log: out.log, onEvent: out.onEvent, ...(probe !== undefined ? { probe } : {}) },
                { maxIterations: flags.maxIterations ?? DEFAULT_MAX_ITERATIONS },
            );
            await writeStatus(join(dir, STATUS_FILE), {
                converged: result.converged,
                iterations: result.iterations,
                steps: result.outcome.steps,
            });
            // Prune AFTER convergence (reconcile throws if it never converges, so a failed apply never deletes):
            // tear down every resource in the last successfully-applied artifact that the new one no longer
            // declares. Deletes need the kept platform nodes' creds, hence the same providers/env as the apply.
            // When --previous isn't explicit, auto-read the .last-applied.json snapshot from the last successful run.
            let pruned: PruneOutcome = { deleted: [], skipped: [] };
            if (previous !== undefined) {
                // Prune is the destructive phase: push the takeover deadline out for a long apply, then confirm
                // we still hold every lock before deleting anything (abort if another run took over).
                await lock.renew();
                await lock.verify();
                // Rewrite the baseline for in-place renames so prune treats a moved id as "became", not
                // "removed" — otherwise it would delete the resource we just re-stamped.
                const baseline = rewriteGraphForMoves(previous, movedApplied);
                pruned = await prune(baseline, graph, { providers: createProviders({ ssh }), log: out.log, onEvent: out.onEvent, env: process.env });
                if (pruned.deleted.length > 0 || pruned.skipped.length > 0) {
                    out.text(
                        `pruned ${pruned.deleted.length} resource(s)${pruned.skipped.length > 0 ? `, ${pruned.skipped.length} left in place` : ""}`,
                    );
                }
            }
            // Snapshot the current artifact so the next apply can prune against it.
            await writeFile(join(dir, LAST_APPLIED_FILE), await readFile(artifact, "utf8"));
            const access = collectAccess(graph, result.outcome.outputs, process.env);
            out.text(`${result.converged ? "converged" : "did not converge"} in ${result.iterations} iteration(s)`);
            if (access.length > 0) {
                await writeAccessFile(join(dir, ACCESS_FILE), access);
                out.text(formatAccessSummary(access));
            }
            out.result({
                converged: result.converged,
                iterations: result.iterations,
                steps: result.outcome.steps,
                outputs: result.outcome.outputs,
                orphans: result.outcome.orphans,
                pruned,
                access,
            });
            // Post a reconcile summary to the Discord #reconcile channel if the graph has a discord resource.
            const reconcileWebhook = result.outcome.outputs["discord"]?.["reconcileWebhook"];
            if (typeof reconcileWebhook === "string" && reconcileWebhook !== "") {
                const creates = result.outcome.steps.filter((s) => s.action === "create").length;
                const updates = result.outcome.steps.filter((s) => s.action === "update").length;
                const noops = result.outcome.steps.filter((s) => s.action === "noop").length;
                const summary = [
                    `**intentic apply** — ${result.converged ? "✅ converged" : "⚠️ did not converge"} in ${result.iterations} iteration(s)`,
                    `📊 ${result.outcome.steps.length} resources: ${creates} created, ${updates} updated, ${noops} unchanged`,
                    ...(result.outcome.orphans.length > 0 ? [`🗑️ ${result.outcome.orphans.length} orphan(s) detected`] : []),
                ].join("\n");
                try {
                    await fetch(reconcileWebhook, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ content: summary }),
                    });
                } catch {
                    out.log("discord: failed to post reconcile summary (non-fatal)");
                }
            }
        } finally {
            process.removeListener("SIGINT", onSignal);
            process.removeListener("SIGTERM", onSignal);
            await lock.release();
        }
    },
});

const adopt = buildCommand<{ artifact?: string }>({
    docs: { brief: "Push the local intent and desired-state repos to the provisioned Forgejo" },
    parameters: {
        flags: { artifact: { kind: "parsed", parse: String, optional: true, brief: `Path to the artifact (default: ${ARTIFACT_PATH})` } },
    },
    async func(this: CommandContext, flags: { artifact?: string }) {
        const out = createOutput(this.process.stdout, outputMode(process.env));
        const artifact = flags.artifact ?? ARTIFACT_PATH;
        const targetDir = dirname(artifact);
        // The scaffold layout: the intent repo is a sibling of the desired-state repo (`init` makes both).
        const intentDir = join(dirname(targetDir), INTENT_DIR);
        loadEnvFile(targetDir);
        const graph = await readArtifact(artifact);
        // Forgejo is what hosts the repos; its node carries the public domain + admin identity we push with.
        const { domain, user, adminPasswordRef: ref } = forgejoIdentity(graph);
        const generatedValues = await readGeneratedSecrets(targetDir);
        const password = ref.source === "generated" ? generatedValues[ref.key] : process.env[ref.key];
        if (password === undefined || password === "") {
            throw new Error(`forgejo admin password (${ref.source} secret ${ref.key}) is not available`);
        }

        // Split the graph's secrets by source and resolve their values: env from the loaded process.env,
        // generated from .secrets.json. These move into Forgejo Actions secrets so the pipelines authenticate
        // without the files (which never leave the operator's machine).
        const { env: envKeys, generated: generatedKeys } = collectSecrets(graph);
        const desiredStateSecrets: Record<string, string> = {};
        for (const key of envKeys) {
            const value = process.env[key];
            if (value !== undefined && value !== "") {
                desiredStateSecrets[key] = value;
            }
        }
        for (const key of generatedKeys) {
            const value = generatedValues[key];
            if (value !== undefined) {
                desiredStateSecrets[key] = value;
            }
        }

        const inputs: PipelineInputs = {
            cliVersion: version,
            user,
            domain,
            configFile: CONFIG_FILE,
            artifactFile: ARTIFACT_FILE,
            intentRepo: INTENT_DIR,
            desiredStateRepo: TARGET_DIR,
            applySecretKeys: Object.keys(desiredStateSecrets).sort(),
            forgejoPasswordKey: ref.key,
        };
        // Seed the pipelines into the repo dirs BEFORE the push, so adopt's normal commit/push carries them.
        await writeControlPlaneWorkflows(intentDir, targetDir, inputs);

        const baseUrl = `https://${domain}`;
        const repos = await adoptRepos({
            baseUrl,
            user,
            password,
            repos: [
                { dir: intentDir, name: INTENT_DIR },
                { dir: targetDir, name: TARGET_DIR },
            ],
            log: out.log,
        });

        // The apply pipeline needs every secret; the resolve pipeline needs the Cloudflare token (for zone
        // discovery) plus the git-push credential it pushes the artifact to the desired-state repo with.
        const intentSecrets: Record<string, string> = { [GIT_USER_SECRET]: user, [GIT_TOKEN_SECRET]: password };
        if (desiredStateSecrets["CLOUDFLARE_API_TOKEN"] !== undefined) {
            intentSecrets["CLOUDFLARE_API_TOKEN"] = desiredStateSecrets["CLOUDFLARE_API_TOKEN"];
        }
        await setRepoSecrets({ api: forgejoApi, baseUrl, user, password, owner: user, name: INTENT_DIR, secrets: intentSecrets });
        await setRepoSecrets({ api: forgejoApi, baseUrl, user, password, owner: user, name: TARGET_DIR, secrets: desiredStateSecrets });
        out.text(
            `set ${Object.keys(intentSecrets).length} secret(s) on ${user}/${INTENT_DIR}, ${Object.keys(desiredStateSecrets).length} on ${user}/${TARGET_DIR}`,
        );
        out.result({
            repos,
            intentSecrets: Object.keys(intentSecrets).sort(),
            desiredStateSecrets: Object.keys(desiredStateSecrets).sort(),
        });
    },
});

interface RestoreFlags {
    readonly artifact?: string;
    readonly snapshot?: string;
    readonly only?: string;
}

const restore = buildCommand<RestoreFlags>({
    docs: { brief: "Restore Forgejo/Komodo from a restic backup snapshot, then re-apply (one-shot recovery)" },
    parameters: {
        flags: {
            artifact: { kind: "parsed", parse: String, optional: true, brief: `Path to the artifact (default: ${ARTIFACT_PATH})` },
            snapshot: { kind: "parsed", parse: String, optional: true, brief: "restic snapshot id to restore (default: latest)" },
            only: { kind: "parsed", parse: String, optional: true, brief: "Which to restore: forgejo | komodo | all (default: all)" },
        },
    },
    async func(this: CommandContext, flags: RestoreFlags) {
        const out = createOutput(this.process.stdout, outputMode(process.env));
        const artifact = flags.artifact ?? ARTIFACT_PATH;
        const dir = dirname(artifact);
        loadEnvFile(dir);
        const graph = await readArtifact(artifact);
        // Recovery re-applies against the same host, so read the admin passwords from the host-authoritative
        // store (no backfill — restore reads what's there rather than reconciling layers).
        const ssh = createSshExecutor(createKnownHostsStore(dir));
        await ensureGeneratedSecrets(generatedSecretStore(graph, dir, ssh, false, out.log), collectSecrets(graph).generated, process.env);
        const backupNode = Object.values(graph.resources).find((node) => node.type === "backup");
        if (backupNode === undefined) {
            throw new Error("no backup resource in the artifact — declare one with i.have.backup and apply it first");
        }
        const scope = flags.only ?? "all";
        if (scope !== "forgejo" && scope !== "komodo" && scope !== "all") {
            throw new Error(`--only must be one of forgejo|komodo|all, got "${scope}"`);
        }
        // Resolve the backup node's inputs (substituting its repo password + backend cred secrets from the
        // loaded env); the same resolved block carries the host SSH creds hostTarget needs.
        const resolved = resolveInputs(backupNode.inputs, createStore(), process.env, { lenient: false });
        const repo = resolved["repo"];
        const password = resolved["password"];
        const image = resolved["image"];
        if (typeof repo !== "string" || typeof password !== "string" || typeof image !== "string") {
            throw new Error("backup resource is missing its repo/password/image inputs");
        }
        const credsRaw = resolved["credentials"];
        const credentials: Record<string, string> = {};
        if (typeof credsRaw === "object" && credsRaw !== null) {
            for (const [key, value] of Object.entries(credsRaw)) {
                if (typeof value === "string") {
                    credentials[key] = value;
                }
            }
        }
        await restoreBackup({
            target: hostTarget(resolved),
            image,
            repo,
            password,
            credentials,
            snapshot: flags.snapshot ?? "latest",
            scope: scope as RestoreScope,
            log: out.log,
            executor: ssh,
        });
        out.result({ snapshot: flags.snapshot ?? "latest", scope });
    },
});

const deploymentsCommand = buildCommand<{ artifact?: string }>({
    docs: { brief: "List the app deployments Komodo manages, with their desired config (read-only)" },
    parameters: {
        flags: { artifact: { kind: "parsed", parse: String, optional: true, brief: `Path to the artifact (default: ${ARTIFACT_PATH})` } },
    },
    async func(this: CommandContext, flags: { artifact?: string }) {
        const out = createOutput(this.process.stdout, outputMode(process.env));
        const deployments = await collectDeployments(flags.artifact ?? ARTIFACT_PATH, out.log);
        out.text(`${deployments.length} deployment(s)`);
        out.result({ deployments });
    },
});

// Used by the sandbox bootstrap (connect.sh / the workspace provider), not operators directly: stand up the
// per-sandbox Cloudflare tunnel + DNS that exposes the daemon at sandbox-<id>.<zone>, reusing the providers'
// Cloudflare client. Prints `TUNNEL_TOKEN=…` / `SANDBOX_HOSTNAME=…` on stdout (progress on stderr) so the
// bootstrap can capture them and run cloudflared. Run inside the sandbox image (which carries this CLI).
const sandboxTunnel = buildCommand<{ service: string; previewService?: string; zone?: string }>({
    docs: { brief: "Create/refresh the per-sandbox Cloudflare tunnel + DNS and print its connector token (used by connect.sh)" },
    parameters: {
        flags: {
            service: {
                kind: "parsed",
                parse: String,
                brief: "Internal service URL the tunnel routes to (e.g. http://intentic-sandbox-workspace:8787)",
            },
            previewService: {
                kind: "parsed",
                parse: String,
                optional: true,
                brief: "Dev-server URL to route the *.preview.<zone> wildcard to (e.g. http://intentic-sandbox-workspace:5173)",
            },
            zone: {
                kind: "parsed",
                parse: String,
                optional: true,
                brief: "Cloudflare zone for the DNS record (default: the API token's sole zone, or set ZONE)",
            },
        },
    },
    async func(this: CommandContext, flags: { service: string; previewService?: string; zone?: string }) {
        const apiToken = process.env["CLOUDFLARE_API_TOKEN"];
        const connectToken = process.env["CONNECT_TOKEN"];
        if (apiToken === undefined || apiToken === "") {
            throw new Error("set CLOUDFLARE_API_TOKEN");
        }
        if (connectToken === undefined || connectToken === "") {
            throw new Error("set CONNECT_TOKEN (the per-sandbox connection token)");
        }
        const zone = flags.zone ?? process.env["ZONE"];
        const { token, hostname } = await createSandboxTunnel({
            apiToken,
            connectToken,
            service: flags.service,
            ...(flags.previewService !== undefined && flags.previewService !== "" ? { previewService: flags.previewService } : {}),
            ...(zone !== undefined && zone !== "" ? { zone } : {}),
            log: (message) => this.process.stderr.write(`${message}\n`),
        });
        // Machine-readable on stdout for connect.sh to capture (progress went to stderr).
        this.process.stdout.write(`TUNNEL_TOKEN=${token}\nSANDBOX_HOSTNAME=${hostname}\n`);
    },
});

// User-facing errors should read as a one-line message, not a JS stack trace — the CLI is driven by end users
// (and by connect.sh inside the sandbox), so a thrown Error renders as "Command failed, <message>". Set
// INTENTIC_DEBUG to keep the stack when chasing an unexpected failure. This overrides stricli's default
// formatter, which prints `error.stack`.
const formatException = (exc: unknown): string => {
    if (exc instanceof Error) {
        return process.env["INTENTIC_DEBUG"] !== undefined ? (exc.stack ?? exc.message) : exc.message;
    }
    return String(exc);
};

export const app = buildApplication(
    buildRouteMap({
        routes: { init, resolve: resolveCommand, plan: planCommand, apply, adopt, restore, deployments: deploymentsCommand, sandboxTunnel },
        docs: { brief: "intentic — intent-driven deployment" },
    }),
    {
        name: "intentic",
        versionInfo: { currentVersion: version },
        scanner: { caseStyle: "allow-kebab-for-camel" },
        localization: { loadText: (locale) => (locale.startsWith("en") ? { ...text_en, formatException } : undefined) },
    },
);
