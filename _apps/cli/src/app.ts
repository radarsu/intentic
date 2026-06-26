import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createStore, plan, prune, reconcile, resolveInputs } from "@intentic/engine";
import { createProviders, createSshProbe, forgejoApi, hostTarget } from "@intentic/providers";
import { resolveState } from "@intentic/state-resolver";
import type { CommandContext } from "@stricli/core";
import { buildApplication, buildCommand, buildRouteMap, numberParser } from "@stricli/core";
import { collectAccess, formatAccessSummary, writeAccessFile } from "./access.js";
import { adoptRepos } from "./adopt.js";
import { GIT_TOKEN_SECRET, GIT_USER_SECRET, type PipelineInputs, setRepoSecrets, writeControlPlaneWorkflows } from "./adopt-pipelines.js";
import {
    ACCESS_FILE,
    ARTIFACT_FILE,
    ARTIFACT_PATH,
    CONFIG_FILE,
    CONFIG_PATH,
    ENV_FILE,
    INTENT_DIR,
    loadEnvFile,
    readArtifact,
    STATUS_FILE,
    TARGET_DIR,
    writeArtifact,
    writeStatus,
} from "./artifact.js";
import { ensureGeneratedSecrets, readGeneratedSecrets } from "./generated-secrets.js";
import { scaffold } from "./init.js";
import { discoverZone, loadIntent } from "./resolve.js";
import { collectSecrets, secretRef, writeEnvExample } from "./secrets.js";

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
        const { intentDir, targetDir } = await scaffold(flags.dir ?? ".", version, flags.link);
        this.process.stdout.write(`initialized ${intentDir} (with ${CONFIG_FILE}) and ${targetDir}\n`);
    },
});

interface ResolveFlags {
    readonly config?: string;
    readonly out?: string;
}

const resolveCommand = buildCommand<ResolveFlags>({
    docs: { brief: "Resolve a deploy.config.ts into the desired-state artifact" },
    parameters: {
        flags: {
            config: { kind: "parsed", parse: String, optional: true, brief: `Path to the intent config (default: ${CONFIG_PATH})` },
            out: { kind: "parsed", parse: String, optional: true, brief: `Path to write the artifact (default: ${ARTIFACT_PATH})` },
        },
    },
    async func(this: CommandContext, flags: ResolveFlags) {
        const intent = await loadIntent(flags.config ?? CONFIG_PATH);
        const out = flags.out ?? ARTIFACT_PATH;
        const dir = dirname(out);
        const zone = await discoverZone(intent, dir);
        const graph = resolveState(intent, zone);
        await writeArtifact(out, graph);
        const count = Object.keys(graph.resources).length;
        this.process.stdout.write(`resolved desired state (${count} resources) → ${out}\n`);
        if (zone !== undefined) {
            this.process.stdout.write(`discovered Cloudflare zone "${zone}" from the API token\n`);
        }
        // The resolver classifies each secret: `env` ones the user must supply (only knowable from the graph,
        // since the resolver injects platform secrets the authored config never names) → .env.example; the
        // `generated` ones (Forgejo/Komodo admin) intentic creates and owns itself → .secrets.json, written
        // here so it exists right after resolve (apply/plan reuse it).
        const { env: envKeys, generated } = collectSecrets(graph);
        if (envKeys.length > 0) {
            await writeEnvExample(join(dir, `${ENV_FILE}.example`), envKeys);
            this.process.stdout.write(`set these in ${ENV_FILE} before apply (see ${ENV_FILE}.example): ${envKeys.join(", ")}\n`);
        }
        if (generated.length > 0) {
            await ensureGeneratedSecrets(dir, generated, process.env);
            this.process.stdout.write(`generated these (stored in .secrets.json): ${generated.join(", ")}\n`);
        }
    },
});

const planCommand = buildCommand<{ artifact?: string }>({
    docs: { brief: "Show what applying the artifact would create/update (read-only)" },
    parameters: {
        flags: { artifact: { kind: "parsed", parse: String, optional: true, brief: `Path to the artifact (default: ${ARTIFACT_PATH})` } },
    },
    async func(this: CommandContext, flags: { artifact?: string }) {
        const log = (message: string): void => this.process.stdout.write(`${message}\n`);
        const artifact = flags.artifact ?? ARTIFACT_PATH;
        const dir = dirname(artifact);
        loadEnvFile(dir);
        const graph = await readArtifact(artifact);
        await ensureGeneratedSecrets(dir, collectSecrets(graph).generated, process.env);
        const outcome = await plan(graph, { providers: createProviders(), log });
        for (const step of outcome.steps) {
            log(`${step.action}\t${step.type}\t${step.id}${step.reason !== undefined ? `\t(${step.reason})` : ""}`);
        }
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
        const log = (message: string): void => this.process.stdout.write(`${message}\n`);
        const artifact = flags.artifact ?? ARTIFACT_PATH;
        const dir = dirname(artifact);
        loadEnvFile(dir);
        const graph = await readArtifact(artifact);
        await ensureGeneratedSecrets(dir, collectSecrets(graph).generated, process.env);
        // Readiness gates target host-internal urls (http://<internalIp>:<port>) reachable only from the host
        // itself, never from this CLI process. Build an SSH probe from the graph's host node so apply gates on
        // the host's own view; resolveInputs substitutes its HOST_SSH_KEY secret from the env loaded above.
        const hostNode = Object.values(graph.resources).find((node) => node.type === "host");
        const probe =
            hostNode === undefined
                ? undefined
                : createSshProbe(hostTarget(resolveInputs(hostNode.inputs, createStore(), process.env, { lenient: false })));
        const result = await reconcile(
            graph,
            { providers: createProviders(), log, ...(probe !== undefined ? { probe } : {}) },
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
        if (flags.previous !== undefined) {
            const previous = await readArtifact(flags.previous);
            const outcome = await prune(previous, graph, { providers: createProviders(), log, env: process.env });
            log(`pruned ${outcome.deleted.length} resource(s)${outcome.skipped.length > 0 ? `, ${outcome.skipped.length} left in place` : ""}`);
        }
        const access = collectAccess(graph, result.outcome.outputs, process.env);
        log(`${result.converged ? "converged" : "did not converge"} in ${result.iterations} iteration(s)`);
        if (access.length > 0) {
            await writeAccessFile(join(dir, ACCESS_FILE), access);
            log(formatAccessSummary(access));
        }
    },
});

const adopt = buildCommand<{ artifact?: string }>({
    docs: { brief: "Push the local intent and desired-state repos to the provisioned Forgejo" },
    parameters: {
        flags: { artifact: { kind: "parsed", parse: String, optional: true, brief: `Path to the artifact (default: ${ARTIFACT_PATH})` } },
    },
    async func(this: CommandContext, flags: { artifact?: string }) {
        const log = (message: string): void => this.process.stdout.write(`${message}\n`);
        const artifact = flags.artifact ?? ARTIFACT_PATH;
        const targetDir = dirname(artifact);
        // The scaffold layout: the intent repo is a sibling of the desired-state repo (`init` makes both).
        const intentDir = join(dirname(targetDir), INTENT_DIR);
        loadEnvFile(targetDir);
        const graph = await readArtifact(artifact);
        // Forgejo is what hosts the repos; its node carries the public domain + admin identity we push with.
        const forgejo = Object.values(graph.resources).find((node) => node.type === "forgejo");
        if (forgejo === undefined) {
            throw new Error("no forgejo resource in the artifact — run `intentic apply` first");
        }
        const domain = forgejo.inputs["domain"];
        const user = forgejo.inputs["adminUser"];
        if (typeof domain !== "string" || typeof user !== "string") {
            throw new Error("forgejo resource is missing its domain/adminUser inputs");
        }
        const ref = secretRef(forgejo.inputs["adminPassword"]);
        if (ref === undefined) {
            throw new Error("forgejo resource is missing its adminPassword secret");
        }
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
        await adoptRepos({
            baseUrl,
            user,
            password,
            repos: [
                { dir: intentDir, name: INTENT_DIR },
                { dir: targetDir, name: TARGET_DIR },
            ],
            log,
        });

        // The apply pipeline needs every secret; the resolve pipeline needs the Cloudflare token (for zone
        // discovery) plus the git-push credential it pushes the artifact to the desired-state repo with.
        const intentSecrets: Record<string, string> = { [GIT_USER_SECRET]: user, [GIT_TOKEN_SECRET]: password };
        if (desiredStateSecrets["CLOUDFLARE_API_TOKEN"] !== undefined) {
            intentSecrets["CLOUDFLARE_API_TOKEN"] = desiredStateSecrets["CLOUDFLARE_API_TOKEN"];
        }
        await setRepoSecrets({ api: forgejoApi, baseUrl, user, password, owner: user, name: INTENT_DIR, secrets: intentSecrets });
        await setRepoSecrets({ api: forgejoApi, baseUrl, user, password, owner: user, name: TARGET_DIR, secrets: desiredStateSecrets });
        log(
            `set ${Object.keys(intentSecrets).length} secret(s) on ${user}/${INTENT_DIR}, ${Object.keys(desiredStateSecrets).length} on ${user}/${TARGET_DIR}`,
        );
    },
});

export const app = buildApplication(
    buildRouteMap({
        routes: { init, resolve: resolveCommand, plan: planCommand, apply, adopt },
        docs: { brief: "intentic — intent-driven deployment" },
    }),
    {
        name: "intentic",
        versionInfo: { currentVersion: version },
        scanner: { caseStyle: "allow-kebab-for-camel" },
    },
);
