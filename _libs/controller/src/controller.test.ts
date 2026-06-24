import { createFakeProviders } from "@intentic/engine";
import { env } from "@intentic/graph";
import type { ForgejoApi } from "@intentic/providers";
import type { Candidate, IntentSet } from "@intentic/resolvers";
import { generateCandidates } from "@intentic/resolvers";
import { expect, test } from "vitest";
import { artifactFileName, runCycle, statusFileName } from "./controller.js";

const NOT_USED = async (): Promise<never> => {
    throw new Error("unused by runCycle");
};

const intent: IntentSet = {
    hosts: [{ id: "host", input: { address: "203.0.113.10", user: "deploy", sshKey: env("HOST_SSH_KEY") } }],
    clouds: [{ id: "cf", input: { accountId: "acc", apiToken: env("CLOUDFLARE_API_TOKEN"), zone: "example.com" } }],
    apps: [{ id: "my-app", on: "host", expose: "cf", environments: { production: { domain: "app.example.com", branch: "main" } } }],
};

const fullEnv = { HOST_SSH_KEY: "k", CLOUDFLARE_API_TOKEN: "k", FORGEJO_ADMIN_PASSWORD: "k", KOMODO_ADMIN_PASSWORD: "k", KOMODO_WEBHOOK_SECRET: "k" };
const access = { baseUrl: "http://10.0.0.1:3000", user: "intentic", password: "pw" };

// A forgejo fake that serves a fixed head commit + config source and records every commit written back.
const fakeForgejo = (head: string | undefined): { api: ForgejoApi; writes: { path: string; content: string }[] } => {
    const writes: { path: string; content: string }[] = [];
    const api: ForgejoApi = {
        findRepo: NOT_USED,
        createRepo: NOT_USED,
        listHooks: NOT_USED,
        createHook: NOT_USED,
        updateHook: NOT_USED,
        latestCommit: async () => head,
        readFile: async () => "export const candidates = [];",
        commitFile: async ({ path, content }) => {
            writes.push({ path, content });
        },
    };
    return { api, writes };
};

const params = (lastSha: string | undefined, api: ForgejoApi) => ({
    forgejo: api,
    access,
    providers: createFakeProviders().providers,
    evaluateIntent: async (): Promise<readonly Candidate[]> => generateCandidates(intent),
    env: fullEnv,
    probe: async () => true,
    log: () => {},
    maxIterations: 3,
    lastSha,
});

test("a new intent commit is computed, stored as the target artifact, executed, and recorded", async () => {
    const { api, writes } = fakeForgejo("sha1");
    const sha = await runCycle(params(undefined, api));

    expect(sha).toBe("sha1");
    expect(writes.map((write) => write.path)).toEqual([artifactFileName, statusFileName]);

    // The stored artifact is the chosen reconciliation-target graph.
    const artifact = JSON.parse(writes[0]?.content ?? "{}");
    expect(artifact.version).toBe(1);
    expect(Object.keys(artifact.resources)).toContain("host-git");

    // The status records a converged execution.
    const status = JSON.parse(writes[1]?.content ?? "{}");
    expect(status).toMatchObject({ intent: "sha1", converged: true });
});

test("no new commit is a no-op cycle", async () => {
    const { api, writes } = fakeForgejo("sha1");
    const sha = await runCycle(params("sha1", api));
    expect(sha).toBe("sha1");
    expect(writes).toEqual([]);
});

test("an empty intent repo is skipped", async () => {
    const { api, writes } = fakeForgejo(undefined);
    const sha = await runCycle(params(undefined, api));
    expect(sha).toBeUndefined();
    expect(writes).toEqual([]);
});
