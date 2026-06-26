import { fakeForgejoApi } from "@intentic/providers";
import { expect, test } from "vitest";
import { applyWorkflowYaml, GIT_TOKEN_SECRET, GIT_USER_SECRET, intentWorkflowYaml, type PipelineInputs, setRepoSecrets } from "./adopt-pipelines.js";

const inputs: PipelineInputs = {
    cliVersion: "1.2.3",
    user: "intentic",
    domain: "git.example.com",
    configFile: "deploy.config.ts",
    artifactFile: "desired-state.json",
    intentRepo: "intent",
    desiredStateRepo: "desired-state",
    applySecretKeys: ["CLOUDFLARE_API_TOKEN", "FORGEJO_ADMIN_PASSWORD", "HOST_SSH_KEY", "KOMODO_ADMIN_PASSWORD"],
    forgejoPasswordKey: "FORGEJO_ADMIN_PASSWORD",
};

test("the intent workflow resolves and pushes to the desired-state repo with the pinned CLI version", () => {
    const yaml = intentWorkflowYaml(inputs);
    expect(yaml).toContain("pnpm dlx @intentic/cli@1.2.3 resolve --config deploy.config.ts --out /tmp/ds/desired-state.json");
    expect(yaml).toContain("clone https://git.example.com/intentic/desired-state.git /tmp/ds");
    // The git-push credential rides on the INTENTIC_GIT_* secrets, mapped to env.
    expect(yaml).toContain(`GIT_USER: \${{ secrets.${GIT_USER_SECRET} }}`);
    expect(yaml).toContain(`GIT_TOKEN: \${{ secrets.${GIT_TOKEN_SECRET} }}`);
    // Only push when the resolve actually changed the artifact.
    expect(yaml).toContain("git diff --cached --quiet");
});

test("the apply workflow injects every secret, diffs against the applied tag, and re-stamps it on success", () => {
    const yaml = applyWorkflowYaml(inputs);
    for (const key of inputs.applySecretKeys) {
        expect(yaml).toContain(`${key}: \${{ secrets.${key} }}`);
    }
    expect(yaml).toContain("pnpm dlx @intentic/cli@1.2.3 apply --artifact desired-state.json $PREV");
    // The prune baseline is the last successfully-applied commit, read from the intentic-applied tag.
    expect(yaml).toContain("git show intentic-applied:desired-state.json > /tmp/previous.json");
    expect(yaml).toContain("git tag -f intentic-applied HEAD");
    // The tag push authenticates with the Forgejo admin password secret (already in the apply env).
    expect(yaml).toContain("printf '%s:%s' 'intentic' \"$FORGEJO_ADMIN_PASSWORD\"");
});

test("setRepoSecrets PUTs each name/value onto the repo via the Forgejo API", async () => {
    const calls: { name: string; secretName: string; data: string }[] = [];
    const api = fakeForgejoApi({
        setRepoSecret: async ({ name, secretName, data }) => {
            calls.push({ name, secretName, data });
        },
    });
    await setRepoSecrets({
        api,
        baseUrl: "https://git.example.com",
        user: "intentic",
        password: "pw",
        owner: "intentic",
        name: "desired-state",
        secrets: { HOST_SSH_KEY: "key", FORGEJO_ADMIN_PASSWORD: "pw" },
    });

    expect(calls).toEqual([
        { name: "desired-state", secretName: "HOST_SSH_KEY", data: "key" },
        { name: "desired-state", secretName: "FORGEJO_ADMIN_PASSWORD", data: "pw" },
    ]);
});
