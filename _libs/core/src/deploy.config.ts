// Developer-authored deployment declaration for @puristic/deploy.
// A real consumer imports the package name:
//   import { defineStack, env, httpOk } from "@puristic/deploy/index.js";
// In-repo we import relatively so it runs under vitest with no resolve condition.
import { defineStack, env, httpOk } from "./index.js";

export const graph = defineStack((s) => {
    // --- Inventory: one SSH + Docker host, one Cloudflare account ---
    const host = s.server("host", {
        host: "203.0.113.10",
        user: "deploy",
        sshKey: env("HOST_SSH_KEY"),
    });

    const cf = s.cloudflare("cf", {
        accountId: "acc_123",
        apiToken: env("CLOUDFLARE_API_TOKEN"),
        zone: "example.com",
    });

    // --- Forgejo: Git + CI, with admin + Actions runner ---
    const forgejo = s.forgejo("forgejo", {
        server: host,
        domain: "git.example.com",
        adminUser: "admin",
        adminPassword: env("FORGEJO_ADMIN_PASSWORD"),
        readyWhen: httpOk("https://git.example.com/api/healthz", { timeout: "120s" }),
    });

    const repo = forgejo.repo("app-repo", { name: "app", private: true });

    s.forgejoRunner("forgejo-runner", {
        server: host,
        instanceUrl: forgejo.url,
        token: forgejo.runnerToken, // cross-phase ref edge forgejo -> runner
    });

    // --- Komodo: deploy orchestrator (wired to Forgejo) ---
    const komodo = s.komodo("komodo", {
        server: host,
        domain: "komodo.example.com",
        forgejoUrl: forgejo.internalUrl,
        runnerToken: forgejo.runnerToken,
        adminPassword: env("KOMODO_ADMIN_PASSWORD"),
        readyWhen: httpOk("https://komodo.example.com/api/health", { timeout: "90s" }),
    });

    // --- The user's own app: ONE repo, TWO environments, TWO domains ---
    const myApp = s.app("my-app", {
        source: repo.cloneUrl,
        deployer: komodo,
        environments: [
            {
                name: "staging",
                branch: "develop",
                domain: "staging.example.com",
                server: host,
                env: { DATABASE_URL: env("STAGING_DATABASE_URL") },
                readyWhen: httpOk("https://staging.example.com/healthz", { timeout: "60s" }),
            },
            {
                name: "production",
                branch: "main",
                domain: "app.example.com",
                server: host,
                env: { DATABASE_URL: env("PRODUCTION_DATABASE_URL") },
                readyWhen: httpOk("https://app.example.com/healthz", { timeout: "60s" }),
            },
        ],
    });

    // --- Cloudflare routes: every public hostname -> the right service ---
    cf.route("route-git", { hostname: "git.example.com", target: forgejo.internalUrl });
    cf.route("route-komodo", { hostname: "komodo.example.com", target: komodo.internalUrl });
    cf.route("route-staging", { hostname: "staging.example.com", target: myApp.environments["staging"].internalUrl });
    cf.route("route-production", { hostname: "app.example.com", target: myApp.environments["production"].internalUrl });
});
