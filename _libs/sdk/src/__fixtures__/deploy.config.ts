// Test fixture: a representative authoring declaration, compiled and asserted against deploy.graph.ts.
// The canonical user-facing example lives in /examples/deploy.config.ts; this copy exists only to pin the
// compiled desired-state graph. In-repo we import relatively so it runs under vitest with no resolve
// condition (a real consumer would `import { defineStack, env } from "@intentic/sdk"`).
import { env } from "@intentic/graph";
import { defineStack } from "../index.js";

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

    // What I want: an app shipped to two environments. The tool derives the Git+CI, deploy orchestrator,
    // runner, repo, and routes on the host I declared, exposed through the Cloudflare account I declared.
    i.want.app("my-app", {
        on: host,
        expose: cf,
        environments: {
            staging: { domain: "staging.example.com", branch: "develop", env: { DATABASE_URL: env("STAGING_DATABASE_URL") } },
            production: { domain: "app.example.com", branch: "main", env: { DATABASE_URL: env("PRODUCTION_DATABASE_URL") } },
        },
    });
});
