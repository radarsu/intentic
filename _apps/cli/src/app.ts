import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createStore, plan, reconcile, resolveInputs } from "@intentic/engine";
import { createProviders, createSshProbe, hostTarget } from "@intentic/providers";
import { resolveState } from "@intentic/state-resolver";
import type { CommandContext } from "@stricli/core";
import { buildApplication, buildCommand, buildRouteMap, numberParser } from "@stricli/core";
import { ARTIFACT_PATH, CONFIG_FILE, CONFIG_PATH, loadEnvFile, readArtifact, STATUS_FILE, writeArtifact, writeStatus } from "./artifact.js";
import { scaffold } from "./init.js";
import { loadIntent } from "./resolve.js";

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
        const graph = resolveState(intent);
        const out = flags.out ?? ARTIFACT_PATH;
        await writeArtifact(out, graph);
        const count = Object.keys(graph.resources).length;
        this.process.stdout.write(`resolved desired state (${count} resources) → ${out}\n`);
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
        loadEnvFile(dirname(artifact));
        const graph = await readArtifact(artifact);
        const outcome = await plan(graph, { providers: createProviders(), log });
        for (const step of outcome.steps) {
            log(`${step.action}\t${step.type}\t${step.id}${step.reason !== undefined ? `\t(${step.reason})` : ""}`);
        }
    },
});

interface ApplyFlags {
    readonly artifact?: string;
    readonly maxIterations?: number;
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
        },
    },
    async func(this: CommandContext, flags: ApplyFlags) {
        const log = (message: string): void => this.process.stdout.write(`${message}\n`);
        const artifact = flags.artifact ?? ARTIFACT_PATH;
        loadEnvFile(dirname(artifact));
        const graph = await readArtifact(artifact);
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
        await writeStatus(join(dirname(artifact), STATUS_FILE), {
            converged: result.converged,
            iterations: result.iterations,
            steps: result.outcome.steps,
        });
        log(`${result.converged ? "converged" : "did not converge"} in ${result.iterations} iteration(s)`);
    },
});

export const app = buildApplication(
    buildRouteMap({
        routes: { init, resolve: resolveCommand, plan: planCommand, apply },
        docs: { brief: "intentic — intent-driven deployment" },
    }),
    {
        name: "intentic",
        versionInfo: { currentVersion: version },
        scanner: { caseStyle: "allow-kebab-for-camel" },
    },
);
