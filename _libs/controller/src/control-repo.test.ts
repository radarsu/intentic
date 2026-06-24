import type { ForgejoRepo } from "@puristic/deploy-providers";
import { fakeForgejoApi } from "@puristic/deploy-providers";
import { expect, test } from "vitest";
import { createControlRepoProvider } from "./control-repo.js";

const ctx = () => ({ env: {}, log: () => {}, id: "intent-repo", output: () => undefined });
const inputs = { baseUrl: "http://10.0.0.1:3000", owner: "puristic", name: "intent", private: true, adminUser: "puristic", adminPassword: "pw" };

test("read returns undefined while the forgejo baseUrl ref is still PENDING", async () => {
    const provider = createControlRepoProvider(fakeForgejoApi({}));
    expect(await provider.read({ ...inputs, baseUrl: undefined }, ctx())).toBeUndefined();
});

test("read returns undefined when the repo does not exist yet", async () => {
    const provider = createControlRepoProvider(fakeForgejoApi({ findRepo: async () => undefined }));
    expect(await provider.read(inputs, ctx())).toBeUndefined();
});

test("read reports the repo's clone/ssh urls when it exists", async () => {
    const repo: ForgejoRepo = { cloneUrl: "https://git/puristic/intent.git", sshUrl: "git@git:puristic/intent.git" };
    const provider = createControlRepoProvider(fakeForgejoApi({ findRepo: async () => repo }));
    expect(await provider.read(inputs, ctx())).toEqual({ outputs: { cloneUrl: repo.cloneUrl, sshUrl: repo.sshUrl } });
});

test("apply creates the repo when absent and is a noop when present", async () => {
    const created: string[] = [];
    const repo: ForgejoRepo = { cloneUrl: "c", sshUrl: "s" };
    const absent = createControlRepoProvider(
        fakeForgejoApi({
            findRepo: async () => undefined,
            createRepo: async ({ name }) => {
                created.push(name);
                return repo;
            },
        }),
    );
    expect(await absent.apply(inputs, undefined, ctx())).toEqual({ cloneUrl: "c", sshUrl: "s" });
    expect(created).toEqual(["intent"]);

    // createRepo is left at the fake's throwing default — apply must not call it when the repo exists.
    const present = createControlRepoProvider(fakeForgejoApi({ findRepo: async () => repo }));
    expect(await present.apply(inputs, undefined, ctx())).toEqual({ cloneUrl: "c", sshUrl: "s" });
});

test("the diff is always a noop", () => {
    expect(createControlRepoProvider(fakeForgejoApi({})).diff(inputs, { outputs: {} })).toEqual({ action: "noop" });
});
