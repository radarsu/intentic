import { dirname, join } from "node:path";
import { forgejoApi } from "@intentic/providers";
import { buildCommand, type CommandContext } from "@stricli/core";
import { loadConfig } from "../env.config.js";
import { ARTIFACT_FILE, ARTIFACT_PATH, CONFIG_FILE, INTENT_DIR, loadEnvFile, readArtifact, TARGET_DIR } from "../lib/artifact.js";
import { createOutput } from "../lib/output.js";
import { version } from "../lib/version.js";
import { GIT_TOKEN_SECRET, GIT_USER_SECRET, type PipelineInputs, setRepoSecrets, writeControlPlaneWorkflows } from "../pipelines/adopt-pipelines.js";
import { forgejoIdentity } from "../pipelines/control-plane-sync.js";
import { readGeneratedSecrets } from "../secrets/generated-secrets.js";
import { collectSecrets } from "../secrets/secrets.js";
import { adoptRepos } from "./adopt.js";

export const adopt = buildCommand<{ artifact?: string }>({
    docs: { brief: "Push the local intent and desired-state repos to the provisioned Forgejo" },
    parameters: {
        flags: { artifact: { kind: "parsed", parse: String, optional: true, brief: `Path to the artifact (default: ${ARTIFACT_PATH})` } },
    },
    async func(this: CommandContext, flags: { artifact?: string }) {
        const out = createOutput(this.process.stdout, loadConfig().intenticOutput);
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
            applySecretKeys: Object.keys(desiredStateSecrets).toSorted(),
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
            intentSecrets: Object.keys(intentSecrets).toSorted(),
            desiredStateSecrets: Object.keys(desiredStateSecrets).toSorted(),
        });
    },
});
