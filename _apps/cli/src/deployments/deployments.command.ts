import { buildCommand, type CommandContext } from "@stricli/core";
import { ARTIFACT_PATH } from "../lib/artifact.js";
import { createOutput, outputMode } from "../lib/output.js";
import { collectDeployments } from "./deployments.js";

export const deploymentsCommand = buildCommand<{ artifact?: string }>({
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
