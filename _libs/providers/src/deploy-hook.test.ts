import { expect, test } from "vitest";
import { createDeployHookProvider } from "./deploy-hook.js";
import type { ForgejoApi, ForgejoHook } from "./forgejo-api.js";

const NOT_USED = async (): Promise<never> => {
    throw new Error("unused by the deploy-hook provider");
};
const api = (overrides: Partial<ForgejoApi>): ForgejoApi => ({
    findRepo: NOT_USED,
    createRepo: NOT_USED,
    listHooks: NOT_USED,
    createHook: NOT_USED,
    updateHook: NOT_USED,
    ...overrides,
});

const ctx = () => ({
    env: {},
    log: () => {},
    id: "my-app.staging-deploy-hook",
    output: () => {
        throw new Error("unused");
    },
});

const inputs = {
    forgejoUrl: "https://git.example.com",
    adminUser: "admin",
    adminPassword: "pw",
    repoName: "my-app",
    komodoUrl: "https://komodo.example.com",
    deployment: "my-app.staging",
    branch: "develop",
    secret: "whsec",
};
const LISTENER = "https://komodo.example.com/listener/github/deployment/my-app.staging/deploy";
const hook = (): ForgejoHook => ({ id: 3, type: "gitea", config: { url: LISTENER }, events: ["push"], active: true });

test("read returns undefined when forgejoUrl or komodoUrl is PENDING", async () => {
    expect(await createDeployHookProvider(api({})).read({ ...inputs, komodoUrl: 42 }, ctx())).toBeUndefined();
});

test("read returns undefined when no hook targets the deploy listener", async () => {
    expect(await createDeployHookProvider(api({ listHooks: async () => [] })).read(inputs, ctx())).toBeUndefined();
});

test("read returns empty outputs when the deploy-listener hook exists", async () => {
    expect(await createDeployHookProvider(api({ listHooks: async () => [hook()] })).read(inputs, ctx())).toEqual({ outputs: {} });
});

test("diff is always noop", () => {
    expect(createDeployHookProvider(api({})).diff(inputs, { outputs: {} })).toEqual({ action: "noop" });
});

test("apply creates a gitea hook targeting the Komodo listener with the shared secret", async () => {
    let created: unknown;
    const provider = createDeployHookProvider(
        api({
            listHooks: async () => [],
            createHook: async (args) => {
                created = args;
            },
        }),
    );
    expect(await provider.apply(inputs, undefined, ctx())).toEqual({});
    expect(created).toMatchObject({ type: "gitea", config: { url: LISTENER, content_type: "json", secret: "whsec" }, events: ["push"] });
});

test("apply updates the existing hook rather than creating", async () => {
    let updatedId: number | undefined;
    const provider = createDeployHookProvider(
        api({
            listHooks: async () => [hook()],
            updateHook: async (args) => {
                updatedId = args.id;
            },
        }),
    );
    await provider.apply(inputs, undefined, ctx());
    expect(updatedId).toBe(3);
});

test("malformed inputs are rejected", async () => {
    await expect(createDeployHookProvider(api({})).read({ ...inputs, secret: 5 }, ctx())).rejects.toThrow(/deploy-hook inputs malformed/);
});
