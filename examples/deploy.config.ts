// Canonical intent file. `intentic resolve` imports this module, reads the exported `intent`, computes
// every valid desired-state artifact (one per option combination that meets the needs), and
// auto-picks one; `intentic apply` then reconciles that artifact until state reads true.
//
// `env` comes from its true source, @intentic/graph (the SDK does not re-export it).

import { env } from "@intentic/graph";
import { defineIntent } from "@intentic/sdk";

export const intent = defineIntent((i) => {
    // What I want: an app shipped to two environments. That's it. The tool derives the needs (source
    // control, Docker registry, infra control, deployment target, domain) and the support stack that meets
    // them — choosing among the catalog's options for each. The host it runs on and the Cloudflare it's
    // exposed through are reconciled as resources in the target artifact; their connection values (host
    // address/user/SSH key, Cloudflare account/API token) are canonical env secrets filled at the
    // decision/PR step, never authored here. The DNS zone is derived from the environment domains.
    i.want.app("my-app", {
        environments: {
            staging: { domain: "staging.example.com", branch: "develop", env: { DATABASE_URL: env("STAGING_DATABASE_URL") } },
            production: { domain: "app.example.com", branch: "main", env: { DATABASE_URL: env("PRODUCTION_DATABASE_URL") } },
        },
    });
});
