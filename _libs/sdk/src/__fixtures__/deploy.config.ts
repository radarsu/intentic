// Test fixture: a representative authoring declaration, compiled and asserted against deploy.graph.ts.
// The canonical user-facing example lives in /examples/deploy.config.ts; this copy exists only to pin the
// compiled desired-state graph. In-repo we import relatively so it runs under vitest with no resolve
// condition (a real consumer would `import { defineStack, env } from "@intentic/sdk"`).
import { env } from "@intentic/graph";
import { defineStack } from "../index.js";

export const graph = defineStack((i) => {
    // What I want: an app shipped to two environments. That's it — the tool derives the Git+CI, deploy
    // orchestrator, runner, repo, routes, and the host/Cloudflare it all runs on, reconciling them as
    // resources in the target artifact (their connection values filled at the decision/PR step).
    i.want.app("my-app", {
        environments: {
            staging: { domain: "staging.example.com", branch: "develop", env: { DATABASE_URL: env("STAGING_DATABASE_URL") } },
            production: { domain: "app.example.com", branch: "main", env: { DATABASE_URL: env("PRODUCTION_DATABASE_URL") } },
        },
    });
});
