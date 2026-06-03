import { expect, test } from "vitest";
import { createAppProvider } from "./app.js";
import type { KomodoApi } from "./komodo-api.js";

const NOT_USED = async (): Promise<never> => {
    throw new Error("unused by the app provider");
};
const api = (overrides: Partial<KomodoApi>): KomodoApi => ({
    health: NOT_USED,
    login: async () => "jwt",
    listBuilds: NOT_USED,
    createBuild: NOT_USED,
    updateBuild: NOT_USED,
    listDeployments: NOT_USED,
    createDeployment: NOT_USED,
    updateDeployment: NOT_USED,
    deploy: NOT_USED,
    listAlerters: NOT_USED,
    getAlerter: NOT_USED,
    createAlerter: NOT_USED,
    updateAlerter: NOT_USED,
    ...overrides,
});

const ctx = () => ({
    env: {},
    log: () => {},
    id: "my-app",
    output: () => {
        throw new Error("unused");
    },
});

const inputs = {
    source: "https://git.example.com/admin/my-app.git",
    repoName: "my-app",
    deployer: "host-deploy",
    komodoUrl: "https://komodo.example.com",
    gitDomain: "git.example.com",
    adminUser: "admin",
    adminPassword: "pw",
};

test("read returns undefined when komodoUrl is PENDING", async () => {
    expect(await createAppProvider(api({})).read({ ...inputs, komodoUrl: 42 }, ctx())).toBeUndefined();
});

test("read returns undefined when the build does not exist", async () => {
    expect(await createAppProvider(api({ listBuilds: async () => [] })).read(inputs, ctx())).toBeUndefined();
});

test("read returns empty outputs when the build exists", async () => {
    expect(await createAppProvider(api({ listBuilds: async () => [{ id: "b1", name: "my-app" }] })).read(inputs, ctx())).toEqual({ outputs: {} });
});

test("read returns undefined when komodo login fails", async () => {
    const provider = createAppProvider(
        api({
            login: async () => {
                throw new Error("401");
            },
        }),
    );
    expect(await provider.read(inputs, ctx())).toBeUndefined();
});

test("apply creates the build with the repo coordinates when absent", async () => {
    let created: unknown;
    const provider = createAppProvider(
        api({
            listBuilds: async () => [],
            createBuild: async (args) => {
                created = args;
            },
        }),
    );
    expect(await provider.apply(inputs, undefined, ctx())).toEqual({});
    expect(created).toMatchObject({ name: "my-app", config: { repo: "admin/my-app", git_provider: "git.example.com", git_account: "admin" } });
});

test("apply updates the existing build rather than creating", async () => {
    let updatedId: string | undefined;
    const provider = createAppProvider(
        api({
            listBuilds: async () => [{ id: "b9", name: "my-app" }],
            updateBuild: async (args) => {
                updatedId = args.id;
            },
        }),
    );
    await provider.apply(inputs, undefined, ctx());
    expect(updatedId).toBe("b9");
});

test("diff is always noop", () => {
    expect(createAppProvider(api({})).diff(inputs, { outputs: {} })).toEqual({ action: "noop" });
});

test("malformed inputs are rejected", async () => {
    await expect(createAppProvider(api({})).read({ ...inputs, repoName: 5 }, ctx())).rejects.toThrow(/app inputs malformed/);
});
