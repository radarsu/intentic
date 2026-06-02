// Golden expected output for ../deploy.config.ts.
// Hand-authored source of truth; the test deep-equals the compiled graph against this.
// Typed against DesiredStateGraph so it cannot structurally drift from the API.
// Note: this captures desired state only — resources + their dependsOn edges. Execution
// order is derived on demand via linearize(graph) and asserted as an invariant, not frozen here.
// The forgejo/forgejo-runner/komodo/repo/cf-route nodes are DERIVED by i.want.app — the author never
// declares them; the resolver picks the implementations and places + exposes them on the inventory.
import type { DesiredStateGraph } from "../index.js";

export const expectedGraph: DesiredStateGraph = {
    version: 1,
    resources: {
        host: {
            id: "host",
            type: "host",
            inputs: { address: "203.0.113.10", user: "deploy", sshKey: { $secret: { source: "env", key: "HOST_SSH_KEY" } } },
            dependsOn: [],
        },
        cf: {
            id: "cf",
            type: "cloudflare",
            inputs: { accountId: "acc_123", apiToken: { $secret: { source: "env", key: "CLOUDFLARE_API_TOKEN" } }, zone: "example.com" },
            dependsOn: [],
        },
        "host-git": {
            id: "host-git",
            type: "forgejo",
            inputs: {
                server: { $ref: "host" },
                domain: "git.example.com",
                adminUser: "admin",
                adminPassword: { $secret: { source: "env", key: "FORGEJO_ADMIN_PASSWORD" } },
            },
            dependsOn: ["host"],
            readyWhen: { check: "httpOk", url: "https://git.example.com/api/healthz", timeout: "120s" },
        },
        "host-git-runner": {
            id: "host-git-runner",
            type: "forgejo-runner",
            inputs: { server: { $ref: "host" }, instanceUrl: { $ref: "host-git.url" }, token: { $ref: "host-git.runnerToken" } },
            dependsOn: ["host", "host-git"],
        },
        "host-deploy": {
            id: "host-deploy",
            type: "komodo",
            inputs: {
                server: { $ref: "host" },
                domain: "komodo.example.com",
                forgejoUrl: { $ref: "host-git.internalUrl" },
                runnerToken: { $ref: "host-git.runnerToken" },
                adminPassword: { $secret: { source: "env", key: "KOMODO_ADMIN_PASSWORD" } },
            },
            dependsOn: ["host", "host-git"],
            readyWhen: { check: "httpOk", url: "https://komodo.example.com/api/health", timeout: "90s" },
        },
        "cf-git-example-com": {
            id: "cf-git-example-com",
            type: "cf-route",
            inputs: { hostname: "git.example.com", target: { $ref: "host-git.internalUrl" } },
            dependsOn: ["cf", "host-git"],
        },
        "cf-komodo-example-com": {
            id: "cf-komodo-example-com",
            type: "cf-route",
            inputs: { hostname: "komodo.example.com", target: { $ref: "host-deploy.internalUrl" } },
            dependsOn: ["cf", "host-deploy"],
        },
        "my-app-repo": {
            id: "my-app-repo",
            type: "repo",
            inputs: { name: "my-app", private: true },
            dependsOn: ["host-git"],
        },
        "my-app": {
            id: "my-app",
            type: "app",
            inputs: { source: { $ref: "my-app-repo.cloneUrl" }, deployer: { $ref: "host-deploy" } },
            dependsOn: ["my-app-repo", "host-deploy"],
        },
        "my-app.staging": {
            id: "my-app.staging",
            type: "deployment",
            inputs: {
                app: { $ref: "my-app" },
                name: "staging",
                branch: "develop",
                domain: "staging.example.com",
                server: { $ref: "host" },
                env: { DATABASE_URL: { $secret: { source: "env", key: "STAGING_DATABASE_URL" } } },
            },
            dependsOn: ["my-app", "host"],
            readyWhen: { check: "httpOk", url: "https://staging.example.com/healthz", timeout: "60s" },
        },
        "my-app.production": {
            id: "my-app.production",
            type: "deployment",
            inputs: {
                app: { $ref: "my-app" },
                name: "production",
                branch: "main",
                domain: "app.example.com",
                server: { $ref: "host" },
                env: { DATABASE_URL: { $secret: { source: "env", key: "PRODUCTION_DATABASE_URL" } } },
            },
            dependsOn: ["my-app", "host"],
            readyWhen: { check: "httpOk", url: "https://app.example.com/healthz", timeout: "60s" },
        },
        "cf-staging-example-com": {
            id: "cf-staging-example-com",
            type: "cf-route",
            inputs: { hostname: "staging.example.com", target: { $ref: "my-app.staging.internalUrl" } },
            dependsOn: ["cf", "my-app.staging"],
        },
        "cf-app-example-com": {
            id: "cf-app-example-com",
            type: "cf-route",
            inputs: { hostname: "app.example.com", target: { $ref: "my-app.production.internalUrl" } },
            dependsOn: ["cf", "my-app.production"],
        },
    },
};
