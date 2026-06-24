// Canonical intent file. `intentic resolve` imports this module, reads the exported `intent`, computes
// every valid desired-state artifact (one per option combination that meets the needs), and
// auto-picks one; `intentic apply` then reconciles that artifact until state reads true.
//
// `env` comes from its true source, @intentic/graph (the SDK does not re-export it).

import { env } from "@intentic/graph";
import { defineIntent } from "@intentic/sdk";

export const intent = defineIntent((i) => {
    // What I have: the host the apps run on (its SSH connection) and the Cloudflare account they're exposed
    // through (account + DNS zone). address/user/accountId/zone are authored literals; the SSH key and API
    // token are env-sourced secrets.
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
    // among the catalog's options for each — on the host I declared, exposed through the Cloudflare I declared.
    i.want.app("my-app", {
        on: host,
        expose: cf,
        environments: {
            staging: { domain: "staging.example.com", branch: "develop", env: { DATABASE_URL: env("STAGING_DATABASE_URL") } },
            production: { domain: "app.example.com", branch: "main", env: { DATABASE_URL: env("PRODUCTION_DATABASE_URL") } },
        },
    });
});
