import { expect, test } from "vitest";
import { createDeploymentProvider } from "./deployment.js";
import type { KomodoApi } from "./komodo-api.js";

const NOT_USED = async (): Promise<never> => {
    throw new Error("unused by the deployment provider");
};
const api = (overrides: Partial<KomodoApi>): KomodoApi => {
    let builds = 0;
    return {
        login: async () => "jwt",
        listBuilds: NOT_USED,
        createBuild: NOT_USED,
        updateBuild: NOT_USED,
        listBuilders: NOT_USED,
        createBuilder: NOT_USED,
        runBuild: async () => {},
        // Each poll reports a newer build, so runBuildAndWait sees the image appear on its next check.
        getBuild: async () => ({ lastBuiltAt: (builds += 1), remoteError: undefined }),
        listDeployments: NOT_USED,
        getDeployment: NOT_USED,
        createDeployment: NOT_USED,
        updateDeployment: NOT_USED,
        deploy: NOT_USED,
        listAlerters: NOT_USED,
        getAlerter: NOT_USED,
        createAlerter: NOT_USED,
        updateAlerter: NOT_USED,
        ...overrides,
    };
};

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
    internalIp: "10.0.0.5",
    port: 24680,
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

const observedConfig = {
    server_id: "host",
    branch: "develop",
    image: { type: "Build", params: { build: "my-app" } },
    environment: [],
} as const;

test("read returns the deterministic url + an internalUrl on the host ip when the deployment exists", async () => {
    const observed = await createDeploymentProvider(
        api({ listDeployments: async () => [{ id: "d1", name: "my-app.staging" }], getDeployment: async () => observedConfig }),
    ).read(inputs, ctx());
    expect(observed?.outputs["url"]).toBe("https://staging.example.com");
    expect(observed?.outputs["internalUrl"]).toMatch(/^http:\/\/10\.0\.0\.5:\d{5}$/);
    expect(observed?.detail).toEqual({ config: observedConfig });
});

test("diff is noop when the live env matches the authored env", () => {
    expect(createDeploymentProvider(api({})).diff(inputs, { outputs: {}, detail: { config: observedConfig } })).toEqual({ action: "noop" });
});

test("diff ignores server + branch (Komodo tracks neither on a Deployment) — only env drives it", () => {
    const drifted = { ...observedConfig, branch: "main", server_id: "elsewhere" };
    expect(createDeploymentProvider(api({})).diff(inputs, { outputs: {}, detail: { config: drifted } })).toEqual({ action: "noop" });
});

test("diff is update when env drifts", () => {
    const withEnv = { ...inputs, env: { DATABASE_URL: "postgres://desired" } };
    const provider = createDeploymentProvider(api({}));
    expect(provider.diff(withEnv, { outputs: {}, detail: { config: observedConfig } }).action).toBe("update");
    const matching = { ...observedConfig, environment: [{ variable: "DATABASE_URL", value: "postgres://desired" }] };
    expect(provider.diff(withEnv, { outputs: {}, detail: { config: matching } })).toEqual({ action: "noop" });
});

test("diff matches Komodo's stored env form (multiline string, spaces around '=')", () => {
    const withEnv = { ...inputs, env: { PORT: "27748" } };
    const stored = { ...observedConfig, environment: "  PORT = 27748\n" };
    expect(createDeploymentProvider(api({})).diff(withEnv, { outputs: {}, detail: { config: stored } })).toEqual({ action: "noop" });
});

test("apply creates the deployment, builds the image, then triggers a deploy", async () => {
    let created: { name: string; config: Record<string, unknown> } | undefined;
    let built: string | undefined;
    let deployed: string | undefined;
    const provider = createDeploymentProvider(
        api({
            listDeployments: async () => [],
            createDeployment: async (args) => {
                created = args;
            },
            runBuild: async (args) => {
                built = args.build;
            },
            deploy: async (args) => {
                deployed = args.deployment;
            },
        }),
    );
    const result = await provider.apply(inputs, undefined, ctx());
    expect(result["url"]).toBe("https://staging.example.com");
    expect(created).toMatchObject({
        name: "my-app.staging",
        config: { server_id: "Local", image: { type: "Build", params: { build_id: "my-app" } } },
    });
    expect(built).toBe("my-app");
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
