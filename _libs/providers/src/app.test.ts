import { expect, test } from "vitest";
import { createAppProvider } from "./app.js";
import type { KomodoApi } from "./komodo-api.js";

const NOT_USED = async (): Promise<never> => {
    throw new Error("unused by the app provider");
};
const api = (overrides: Partial<KomodoApi>): KomodoApi => ({
    login: async () => "jwt",
    listBuilds: NOT_USED,
    createBuild: NOT_USED,
    updateBuild: NOT_USED,
    // The auto-created "Local" Server builder exists by default so apply finds it without creating one.
    listBuilders: async () => [{ id: "builder-1", name: "Local" }],
    createBuilder: NOT_USED,
    runBuild: NOT_USED,
    getBuild: NOT_USED,
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
    gitInternalUrl: "http://10.0.0.5:3000",
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

test("apply creates the build with the repo coordinates + builder when absent", async () => {
    let created: { name: string; config: Record<string, unknown> } | undefined;
    const provider = createAppProvider(
        api({
            listBuilds: async () => [],
            createBuild: async (args) => {
                created = args;
            },
        }),
    );
    expect(await provider.apply(inputs, undefined, ctx())).toEqual({});
    // git_provider is Forgejo's internal authority (host:port) over plain http — Komodo clones host-locally.
    expect(created).toMatchObject({
        name: "my-app",
        config: { repo: "admin/my-app", git_provider: "10.0.0.5:3000", git_account: "admin", git_https: false },
    });
    expect(created?.config["builder_id"]).toBe("builder-1");
});

test("apply creates the Server builder when none exists, then references it", async () => {
    let builder: { name: string; config: unknown } | undefined;
    let created: { config: Record<string, unknown> } | undefined;
    let listed = 0;
    const provider = createAppProvider(
        api({
            // First listing is empty (no builder), second returns the just-created one.
            listBuilders: async () => (listed++ === 0 ? [] : [{ id: "builder-9", name: "Local" }]),
            createBuilder: async (args) => {
                builder = args;
            },
            listBuilds: async () => [],
            createBuild: async (args) => {
                created = args;
            },
        }),
    );
    await provider.apply(inputs, undefined, ctx());
    expect(builder).toMatchObject({ name: "Local", config: { type: "Server", params: { server_id: "Local" } } });
    expect(created?.config["builder_id"]).toBe("builder-9");
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
