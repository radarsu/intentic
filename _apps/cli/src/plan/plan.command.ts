import { dirname } from "node:path";
import { plan } from "@intentic/engine";
import { createProviders, createSshExecutor } from "@intentic/providers";
import { buildCommand, type CommandContext } from "@stricli/core";
import { loadConfig } from "../env.config.js";
import { ARTIFACT_PATH, loadEnvFile, readArtifact } from "../lib/artifact.js";
import { createKnownHostsStore } from "../lib/known-hosts.js";
import { createOutput } from "../lib/output.js";
import { ensureGeneratedSecrets } from "../secrets/generated-secrets.js";
import { generatedSecretStore } from "../secrets/secret-store.js";
import { collectSecrets } from "../secrets/secrets.js";

export const planCommand = buildCommand<{ artifact?: string }>({
    docs: { brief: "Show what applying the artifact would create/update (read-only)" },
    parameters: {
        flags: { artifact: { kind: "parsed", parse: String, optional: true, brief: `Path to the artifact (default: ${ARTIFACT_PATH})` } },
    },
    async func(this: CommandContext, flags: { artifact?: string }) {
        const out = createOutput(this.process.stdout, loadConfig().intenticOutput);
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
