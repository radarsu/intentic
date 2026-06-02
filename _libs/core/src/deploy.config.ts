// Developer-authored deployment declaration for @puristic/deploy-core.
// A real consumer imports the package name:
//   import { defineStack, env } from "@puristic/deploy-core";
// In-repo we import relatively so it runs under vitest with no resolve condition.
import { env } from "@puristic/deploy-protocol";
import { defineStack } from "./index.js";

export const graph = defineStack((i) => {
    // What I have: one SSH + Docker host, one Cloudflare account.
    const host = i.have.host("host", {
        address: "203.0.113.10",
        user: "deploy",
        sshKey: env("HOST_SSH_KEY"),
    });

    const cf = i.have.cloudflare("cf", {
        accountId: "acc_123",
        apiToken: env("CLOUDFLARE_API_TOKEN"),
        zone: "example.com",
    });

    // What I want: an app shipped to two environments. That's it — the tool derives the Git+CI,
    // deploy orchestrator, runner, repo, and routes that "ship this from source on owned infra" requires.
    i.want.app("my-app", {
        on: host,
        expose: cf,
        environments: {
            staging: { domain: "staging.example.com", branch: "develop", env: { DATABASE_URL: env("STAGING_DATABASE_URL") } },
            production: { domain: "app.example.com", branch: "main", env: { DATABASE_URL: env("PRODUCTION_DATABASE_URL") } },
        },
    });
});
