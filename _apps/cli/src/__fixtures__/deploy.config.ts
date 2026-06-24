import { env } from "@intentic/graph";
import { defineCandidates } from "@intentic/sdk";

// A self-contained intent config for the cli tests, mirroring examples/deploy.config.ts.
export const candidates = defineCandidates((i) => {
    i.want.app("my-app", {
        environments: {
            staging: { domain: "staging.example.com", branch: "develop", env: { DATABASE_URL: env("STAGING_DATABASE_URL") } },
            production: { domain: "app.example.com", branch: "main", env: { DATABASE_URL: env("PRODUCTION_DATABASE_URL") } },
        },
    });
});
