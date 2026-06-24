import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { plan, reconcile } from "@intentic/engine";
import { createProviders } from "@intentic/providers";
import { choose } from "@intentic/resolvers";
import type { CommandContext } from "@stricli/core";
import { buildApplication, buildCommand, buildRouteMap, numberParser } from "@stricli/core";
import { ARTIFACT_FILE, CONFIG_FILE, readArtifact, STATUS_FILE, writeArtifact, writeStatus } from "./artifact.js";
import { scaffold } from "./init.js";
import { loadCandidates } from "./resolve.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const DEFAULT_MAX_ITERATIONS = 5;

const init = buildCommand<{ dir?: string }>({
    docs: { brief: "Scaffold local intent and reconciliation-target git repos" },
    parameters: { flags: { dir: { kind: "parsed", parse: String, optional: true, brief: "Directory to scaffold in (default: .)" } } },
    async func(this: CommandContext, flags: { dir?: string }) {
        const { intentDir, targetDir } = await scaffold(flags.dir ?? ".");
        this.process.stdout.write(`initialized ${intentDir} (with ${CONFIG_FILE}) and ${targetDir}\n`);
    },
});

interface ResolveFlags {
    readonly config?: string;
    readonly out?: string;
    readonly prefer?: string;
}

const resolveCommand = buildCommand<ResolveFlags>({
    docs: { brief: "Resolve a deploy.config.ts into a reconciliation-target artifact" },
    parameters: {
        flags: {
            config: { kind: "parsed", parse: String, optional: true, brief: `Path to the intent config (default: ${CONFIG_FILE})` },
            out: { kind: "parsed", parse: String, optional: true, brief: `Path to write the artifact (default: ${ARTIFACT_FILE})` },
            prefer: { kind: "parsed", parse: String, optional: true, brief: "Candidate key to choose (default: the only/first candidate)" },
        },
    },
    async func(this: CommandContext, flags: ResolveFlags) {
        const candidates = await loadCandidates(flags.config ?? CONFIG_FILE);
        const chosen = choose(candidates, flags.prefer);
        const out = flags.out ?? ARTIFACT_FILE;
        await writeArtifact(out, chosen.graph);
        const count = Object.keys(chosen.graph.resources).length;
        this.process.stdout.write(`resolved ${candidates.length} candidate(s); chose "${chosen.key}" (${count} resources) → ${out}\n`);
    },
});

const planCommand = buildCommand<{ artifact?: string }>({
    docs: { brief: "Show what applying the artifact would create/update (read-only)" },
    parameters: {
        flags: { artifact: { kind: "parsed", parse: String, optional: true, brief: `Path to the artifact (default: ${ARTIFACT_FILE})` } },
    },
    async func(this: CommandContext, flags: { artifact?: string }) {
        const log = (message: string): void => this.process.stdout.write(`${message}\n`);
        const graph = await readArtifact(flags.artifact ?? ARTIFACT_FILE);
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
    docs: { brief: "Execute the reconciliation-target artifact until state reads true" },
    parameters: {
        flags: {
            artifact: { kind: "parsed", parse: String, optional: true, brief: `Path to the artifact (default: ${ARTIFACT_FILE})` },
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
        const artifact = flags.artifact ?? ARTIFACT_FILE;
        const graph = await readArtifact(artifact);
        const result = await reconcile(
            graph,
            { providers: createProviders(), log },
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
