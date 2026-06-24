import { expect, test } from "vitest";
import type { ForgejoApi } from "./forgejo-api.js";
import { createRepoProvider } from "./repo.js";

const NOT_USED = async (): Promise<never> => {
    throw new Error("unused by the repo provider");
};
const api = (overrides: Partial<ForgejoApi>): ForgejoApi => ({
    findRepo: NOT_USED,
    createRepo: NOT_USED,
    listHooks: NOT_USED,
    createHook: NOT_USED,
    updateHook: NOT_USED,
    latestCommit: NOT_USED,
    readFile: NOT_USED,
    commitFile: NOT_USED,
    ...overrides,
});

const ctx = (log: (message: string) => void = () => {}) => ({
    env: {},
    log,
    id: "my-app-repo",
    output: () => {
        throw new Error("unused");
    },
});

const inputs = {
    name: "my-app",
    private: true,
    forgejoUrl: "https://git.example.com",
    domain: "git.example.com",
    adminUser: "admin",
    adminPassword: "pw",
};
const derived = { cloneUrl: "https://git.example.com/admin/my-app.git", sshUrl: "git@git.example.com:admin/my-app.git" };

test("read returns undefined when forgejoUrl is not yet resolved (PENDING)", async () => {
    expect(await createRepoProvider(api({})).read({ ...inputs, forgejoUrl: 42 }, ctx())).toBeUndefined();
});

test("read returns undefined when the repo does not exist", async () => {
    expect(await createRepoProvider(api({ findRepo: async () => undefined })).read(inputs, ctx())).toBeUndefined();
});

test("read returns deterministically re-derived clone/ssh urls when the repo exists", async () => {
    const observed = await createRepoProvider(api({ findRepo: async () => ({ cloneUrl: "https://other/x.git", sshUrl: "git@other:x.git" }) })).read(
        inputs,
        ctx(),
    );
    expect(observed).toEqual({ outputs: derived });
});

test("read returns undefined and logs when forgejo is unreachable", async () => {
    const logs: string[] = [];
    const provider = createRepoProvider(
        api({
            findRepo: async () => {
                throw new Error("ECONNREFUSED");
            },
        }),
    );
    expect(
        await provider.read(
            inputs,
            ctx((m) => logs.push(m)),
        ),
    ).toBeUndefined();
    expect(logs.some((m) => m.includes("not reachable"))).toBe(true);
});

test("apply creates the repo when absent and returns re-derived urls", async () => {
    let created: unknown;
    const provider = createRepoProvider(
        api({
            findRepo: async () => undefined,
            createRepo: async (args) => {
                created = args;
                return { cloneUrl: "x", sshUrl: "y" };
            },
        }),
    );
    expect(await provider.apply(inputs, undefined, ctx())).toEqual(derived);
    expect(created).toMatchObject({ owner: "admin", name: "my-app", private: true });
});

test("apply does not create when the repo already exists", async () => {
    let createCalled = false;
    const provider = createRepoProvider(
        api({
            findRepo: async () => ({ cloneUrl: "x", sshUrl: "y" }),
            createRepo: async () => {
                createCalled = true;
                return { cloneUrl: "x", sshUrl: "y" };
            },
        }),
    );
    await provider.apply(inputs, undefined, ctx());
    expect(createCalled).toBe(false);
});

test("diff is always noop", () => {
    expect(createRepoProvider(api({})).diff(inputs, { outputs: derived })).toEqual({ action: "noop" });
});

test("malformed inputs are rejected", async () => {
    await expect(createRepoProvider(api({})).read({ ...inputs, adminPassword: 5 }, ctx())).rejects.toThrow(/repo inputs malformed/);
});
