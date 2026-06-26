// Canonical intent file. `intentic resolve` imports this module, reads the exported `intent`, computes
// every valid desired-state artifact (one per option combination that meets the needs), and
// auto-picks one; `intentic apply` then reconciles that artifact until state reads true.
//
// `env` comes from its true source, @intentic/graph (the SDK does not re-export it).

import { env } from "@intentic/graph";
import { defineIntent } from "@intentic/sdk";

export const intent = defineIntent((i) => {
    // What I have: the host the apps run on (its SSH connection) and the Cloudflare account they're exposed
    // through. address/user are authored literals and the SSH key + API token are env-sourced secrets; the DNS
    // zone and the account that owns it are discovered from the API token (the app domains pick which of the
    // token's zones to use), so neither is authored here.
    const host = i.have.host("host", {
        address: "203.0.113.10",
        user: "deploy",
        sshKey: env("HOST_SSH_KEY"),
    });

    const cf = i.have.cloudflare("cf", {
        apiToken: env("CLOUDFLARE_API_TOKEN"),
    });

    // What I have: a Discord bot that intentic uses as the back-communication channel. intentic owns the
    // full server structure (categories, channels, webhooks); the operator supplies only the bot token.
    // CI/CD notifications + reconcile summaries are posted automatically.
    i.have.discord("discord", {
        botToken: env("DISCORD_BOT_TOKEN"),
    });

    // What I want (a shared service): SignOz for observability, deployed onto the host and exposed at its own
    // domain. Apps wire to it via `observe` below; intentic injects its OTLP endpoint into each deployment.
    const obs = i.want.service("obs", {
        kind: "signoz",
        on: host,
        expose: cf,
        domain: "signoz.example.com",
    });

    // Who works on the app: people get a Forgejo git account + a Komodo UI user (each with an intentic-generated
    // password, surfaced in the secrets file). A team becomes a Forgejo organization + team and a Komodo
    // permission scope: its members can act on the deployments of the apps it manages at the `komodo` level.
    const alice = i.want.user("alice", { username: "alice", email: "alice@example.com" });
    const bob = i.want.user("bob", { username: "bob", email: "bob@example.com" });
    const platform = i.want.team("platform", { members: [alice, bob], komodo: "execute" });

    // What I want (an app): shipped to two environments. The tool derives the needs (source control, Docker
    // registry, infra control, deployment target, domain) and the support stack that meets them — on the host
    // I declared, exposed through the Cloudflare I declared — and exports the app's telemetry to `obs`. The
    // `platform` team owns the app: its org owns the repo (the repo + image namespace) and its members get
    // write on the repo + Komodo execute on the deployments.
    i.want.app("my-app", {
        on: host,
        expose: cf,
        observe: obs,
        teams: [{ team: platform, role: "write" }],
        environments: {
            staging: { domain: "staging.example.com", branch: "develop", env: { DATABASE_URL: env("STAGING_DATABASE_URL") } },
            production: { domain: "app.example.com", branch: "main", env: { DATABASE_URL: env("PRODUCTION_DATABASE_URL") } },
        },
    });
});
