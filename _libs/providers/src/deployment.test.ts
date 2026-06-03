import { expect, test } from "vitest";
import { createDeploymentProvider } from "./deployment.js";
import type { KomodoApi } from "./komodo-api.js";

const NOT_USED = async (): Promise<never> => {
    throw new Error("unused by the deployment provider");
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
    id: "my-app.staging",
    output: () => {
        throw new Error("unused");
    },
});

const inputs = {
    app: "my-app",
    name: "staging",
    branch: "develop",
    domain: "staging.example.com",
    server: "host",
    internalIp: "10.0.0.5",
    komodoUrl: "https://komodo.example.com",
    adminUser: "admin",
    adminPassword: "pw",
    env: {},
};

test("read returns undefined when komodoUrl is PENDING", async () => {
    expect(await createDeploymentProvider(api({})).read({ ...inputs, komodoUrl: 42 }, ctx())).toBeUndefined();
});

test("read returns undefined when the deployment does not exist", async () => {
    expect(await createDeploymentProvider(api({ listDeployments: async () => [] })).read(inputs, ctx())).toBeUndefined();
});

test("read returns the deterministic url + an internalUrl on the host ip when the deployment exists", async () => {
    const observed = await createDeploymentProvider(
        api({ listDeployments: async () => [{ id: "d1", name: "my-app.staging", state: "Running" }] }),
    ).read(inputs, ctx());
    expect(observed?.outputs["url"]).toBe("https://staging.example.com");
    expect(observed?.outputs["internalUrl"]).toMatch(/^http:\/\/10\.0\.0\.5:\d{5}$/);
});

test("diff is noop when Running and update otherwise", () => {
    const provider = createDeploymentProvider(api({}));
    expect(provider.diff(inputs, { outputs: {}, detail: { state: "Running" } })).toEqual({ action: "noop" });
    expect(provider.diff(inputs, { outputs: {}, detail: { state: "Exited" } }).action).toBe("update");
});

test("apply creates the deployment then triggers a deploy", async () => {
    let created: unknown;
    let deployed: string | undefined;
    const provider = createDeploymentProvider(
        api({
            listDeployments: async () => [],
            createDeployment: async (args) => {
                created = args;
            },
            deploy: async (args) => {
                deployed = args.deployment;
            },
        }),
    );
    const result = await provider.apply(inputs, undefined, ctx());
    expect(result["url"]).toBe("https://staging.example.com");
    expect(created).toMatchObject({ name: "my-app.staging" });
    expect(deployed).toBe("my-app.staging");
});

test("apply updates the existing deployment then deploys", async () => {
    let updatedId: string | undefined;
    let deployed = false;
    const provider = createDeploymentProvider(
        api({
            listDeployments: async () => [{ id: "d7", name: "my-app.staging" }],
            updateDeployment: async (args) => {
                updatedId = args.id;
            },
            deploy: async () => {
                deployed = true;
            },
        }),
    );
    await provider.apply(inputs, undefined, ctx());
    expect(updatedId).toBe("d7");
    expect(deployed).toBe(true);
});

test("malformed inputs are rejected", async () => {
    await expect(createDeploymentProvider(api({})).read({ ...inputs, internalIp: 5 }, ctx())).rejects.toThrow(/deployment inputs malformed/);
});
