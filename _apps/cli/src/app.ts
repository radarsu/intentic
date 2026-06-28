import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createStore, type PruneOutcome, plan, prune, reconcile, resolveInputs } from "@intentic/engine";
import { createProviders, createSshExecutor, createSshProbe, forgejoApi, hostTarget, type RestoreScope, restoreBackup } from "@intentic/providers";
import { resolveState } from "@intentic/state-resolver";
import type { CommandContext } from "@stricli/core";
import { buildApplication, buildCommand, buildRouteMap, numberParser } from "@stricli/core";
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
import { ensureGeneratedSecrets, readGeneratedSecrets } from "./generated-secrets.js";
import { scaffold } from "./init.js";
import { createKnownHostsStore } from "./known-hosts.js";
import { createOutput, outputMode } from "./output.js";
import { discoverZone, loadIntent } from "./resolve.js";
import { collectSecrets, writeEnvExample } from "./secrets.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const DEFAULT_MAX_ITERATIONS = 5;

const init = buildCommand<{ dir?: string; link: boolean }>({
    docs: { brief: "Scaffold local intent and desired-state git repos" },
    parameters: {
        flags: {
            dir: { kind: "parsed", parse: String, optional: true, brief: "Directory to scaffold in (default: .)" },
            link: { kind: "boolean", brief: "Link @intentic/* to this monorepo's _libs for local development against unpublished packages" },
        },
    },
    async func(this: CommandContext, flags: { dir?: string; link: boolean }) {
        const out = createOutput(this.process.stdout, outputMode(process.env));
        const { intentDir, targetDir } = await scaffold(flags.dir ?? ".", version, flags.link);
        out.text(`initialized ${intentDir} (with ${CONFIG_FILE}) and ${targetDir}`);
        out.result({ intentDir, targetDir });
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
            await ensureGeneratedSecrets(dir, generated, process.env);
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
        await ensureGeneratedSecrets(dir, collectSecrets(graph).generated, process.env);
        const ssh = createSshExecutor(createKnownHostsStore(dir));
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
        await ensureGeneratedSecrets(dir, collectSecrets(graph).generated, process.env);
        const ssh = createSshExecutor(createKnownHostsStore(dir));
        // Readiness gates target host-internal urls (http://<internalIp>:<port>) reachable only from the host
        // itself, never from this CLI process. Build SSH probes from every host node in the graph so apply
        // gates on each host's own view; resolveInputs substitutes SSH_KEY secrets from the env loaded above.
        // The composite probe tries each host until one can reach the URL (the wrong host simply fails wget).
        const hostNodes = Object.values(graph.resources).filter((node) => node.type === "host");
        const probes = hostNodes.map((node) =>
            createSshProbe(hostTarget(resolveInputs(node.inputs, createStore(), process.env, { lenient: false })), ssh),
        );
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
        const previousPath = flags.previous ?? join(dir, LAST_APPLIED_FILE);
        let pruned: PruneOutcome = { deleted: [], skipped: [] };
        if (existsSync(previousPath)) {
            const previous = await readArtifact(previousPath);
            pruned = await prune(previous, graph, { providers: createProviders({ ssh }), log: out.log, onEvent: out.onEvent, env: process.env });
            if (pruned.deleted.length > 0 || pruned.skipped.length > 0) {
                out.text(`pruned ${pruned.deleted.length} resource(s)${pruned.skipped.length > 0 ? `, ${pruned.skipped.length} left in place` : ""}`);
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
        await ensureGeneratedSecrets(dir, collectSecrets(graph).generated, process.env);
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
            executor: createSshExecutor(createKnownHostsStore(dir)),
        });
        out.result({ snapshot: flags.snapshot ?? "latest", scope });
    },
});

export const app = buildApplication(
    buildRouteMap({
        routes: { init, resolve: resolveCommand, plan: planCommand, apply, adopt, restore },
        docs: { brief: "intentic — intent-driven deployment" },
    }),
    {
        name: "intentic",
        versionInfo: { currentVersion: version },
        scanner: { caseStyle: "allow-kebab-for-camel" },
    },
);
