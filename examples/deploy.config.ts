// Canonical intent file. Push this into the control plane's `intent` repo: the controller imports the
// module, reads the exported `candidates`, computes every valid reconciliation-target artifact (one per
// option combination that meets the needs), auto-picks one, stores it in the `reconciliation-target`
// repo, and reconciles it until state reads true.
//
// `env` comes from its true source, @intentic/graph (the SDK does not re-export it).

import { env } from "@intentic/graph";
import { defineCandidates } from "@intentic/sdk";

export const candidates = defineCandidates((i) => {
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

    // What I want: an app shipped to two environments. The tool derives the needs (source control, Docker
    // registry, infra control, deployment target, domain) and the support stack that meets them — choosing
    // among the catalog's options for each.
    i.want.app("my-app", {
        on: host,
        expose: cf,
        environments: {
            staging: { domain: "staging.example.com", branch: "develop", env: { DATABASE_URL: env("STAGING_DATABASE_URL") } },
            production: { domain: "app.example.com", branch: "main", env: { DATABASE_URL: env("PRODUCTION_DATABASE_URL") } },
        },
    });
});
