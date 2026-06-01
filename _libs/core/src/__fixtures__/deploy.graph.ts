// Golden expected output for ../deploy.config.ts.
// Hand-authored source of truth; the test deep-equals the compiled graph against this.
// Typed against DesiredStateGraph so it cannot structurally drift from the API.
// Note: this captures desired state only — resources + their dependsOn edges. Execution
// order is derived on demand via linearize(graph) and asserted as an invariant, not frozen here.
import type { DesiredStateGraph } from "../index.js";

export const expectedGraph: DesiredStateGraph = {
    version: 1,
    resources: {
        host: {
            id: "host",
            type: "server",
            inputs: { host: "203.0.113.10", user: "deploy", sshKey: { $secret: { source: "env", key: "HOST_SSH_KEY" } } },
            dependsOn: [],
        },
        cf: {
            id: "cf",
            type: "cloudflare",
            inputs: { accountId: "acc_123", apiToken: { $secret: { source: "env", key: "CLOUDFLARE_API_TOKEN" } }, zone: "example.com" },
            dependsOn: [],
        },
        forgejo: {
            id: "forgejo",
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
        "app-repo": {
            id: "app-repo",
            type: "repo",
            inputs: { name: "app", private: true },
            dependsOn: ["forgejo"],
        },
        "forgejo-runner": {
            id: "forgejo-runner",
            type: "forgejo-runner",
            inputs: { server: { $ref: "host" }, instanceUrl: { $ref: "forgejo.url" }, token: { $ref: "forgejo.runnerToken" } },
            dependsOn: ["host", "forgejo"],
        },
        komodo: {
            id: "komodo",
            type: "komodo",
            inputs: {
                server: { $ref: "host" },
                domain: "komodo.example.com",
                forgejoUrl: { $ref: "forgejo.internalUrl" },
                runnerToken: { $ref: "forgejo.runnerToken" },
                adminPassword: { $secret: { source: "env", key: "KOMODO_ADMIN_PASSWORD" } },
            },
            dependsOn: ["host", "forgejo"],
            readyWhen: { check: "httpOk", url: "https://komodo.example.com/api/health", timeout: "90s" },
        },
        "my-app": {
            id: "my-app",
            type: "app",
            inputs: { source: { $ref: "app-repo.cloneUrl" }, deployer: { $ref: "komodo" } },
            dependsOn: ["app-repo", "komodo"],
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
        "route-git": {
            id: "route-git",
            type: "cf-route",
            inputs: { hostname: "git.example.com", target: { $ref: "forgejo.internalUrl" } },
            dependsOn: ["cf", "forgejo"],
        },
        "route-komodo": {
            id: "route-komodo",
            type: "cf-route",
            inputs: { hostname: "komodo.example.com", target: { $ref: "komodo.internalUrl" } },
            dependsOn: ["cf", "komodo"],
        },
        "route-staging": {
            id: "route-staging",
            type: "cf-route",
            inputs: { hostname: "staging.example.com", target: { $ref: "my-app.staging.internalUrl" } },
            dependsOn: ["cf", "my-app.staging"],
        },
        "route-production": {
            id: "route-production",
            type: "cf-route",
            inputs: { hostname: "app.example.com", target: { $ref: "my-app.production.internalUrl" } },
            dependsOn: ["cf", "my-app.production"],
        },
    },
};
