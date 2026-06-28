# intentic

**Infrastructure as intent for self-hosters.** You declare *what you have* — a server, a Cloudflare account — and *what you want* — an app. intentic derives everything in between: it resolves your intent into a desired-state graph and runs a reconcile loop that drives your real infrastructure toward it, fixing drift until reality matches. A declarative, git-reviewed source of truth instead of clicking through dashboards.

You never wire the integrations yourself. You declare clean interfaces; intentic picks and glues the providers (git, CI, a registry, a deploy orchestrator, a tunnel, DNS) to satisfy them.

## Demonstrate

**1. Declare what you have and what you want — one file:**

```ts
// intent/deploy.config.ts
import { env } from "@intentic/graph";
import { defineIntent } from "@intentic/sdk";

export const intent = defineIntent((i) => {
    const host = i.have.host("host", {
        address: "203.0.113.10",
        user: "deploy",
        sshKey: env("HOST_SSH_KEY"),
    });

    const cf = i.have.cloudflare("cf", {
        apiToken: env("CLOUDFLARE_API_TOKEN"),
    });

    i.want.app("my-app", {
        on: host,
        expose: cf,
        environments: {
            production: { domain: "app.example.com", branch: "main", env: { DATABASE_URL: env("PRODUCTION_DATABASE_URL") } },
        },
    });
});
```

That is the entire input. You never name Forgejo, Komodo, a tunnel, or a DNS record — intentic derives them from your intent.

**2. Scaffold, resolve, preview, apply:**

```sh
intentic init
```
```text
initialized intent (with deploy.config.ts) and desired-state
```

Put your secrets in `desired-state/.env` (the Cloudflare token is read first, to discover your zone), then:

```sh
intentic resolve
```
```text
resolved desired state (12 resources) → desired-state/desired-state.json
discovered Cloudflare zone "example.com" from the API token
set these in .env before apply (see .env.example): HOST_SSH_KEY, CLOUDFLARE_API_TOKEN, PRODUCTION_DATABASE_URL
generated these (stored in .secrets.json): FORGEJO_ADMIN_PASSWORD, KOMODO_ADMIN_PASSWORD
```

```sh
intentic plan          # read-only preview of what apply will do
```
```text
create   host            host
create   cloudflare      cf
create   forgejo         host-git
create   forgejo-runner  host-git-runner
create   komodo          host-deploy
create   tunnel          host-tunnel
create   cf-route        cf-git-example-com
create   cf-route        cf-deploy-example-com
create   cf-route        cf-app-example-com
create   repo            my-app-repo
create   ci              my-app.production-ci
create   deployment      my-app.production
```

```sh
intentic apply         # execute until state reads true
```
```text
converged in 2 iteration(s)

Access:
  Forgejo (git)  https://git.example.com
    user: intentic   password: (generated — see .secrets.json)
  Komodo (deploys)  https://deploy.example.com
    user: intentic   password: (generated — see .secrets.json)
  my-app.production  https://app.example.com
```

> Output above is illustrative; the resource count and ordering follow your intent.

**3. What those two `i.have` lines and one `i.want.app` stood up** — on your own server, with zero inbound ports:

- **Forgejo** — git + container registry, at `git.example.com`
- **Forgejo runner** — CI that builds and pushes your app image on every push
- **Komodo** — deploy orchestrator + UI, at `deploy.example.com`, rolling out new images
- **one Cloudflare Tunnel** — outbound-only; the host opens no ports
- **a proxied DNS route per hostname** — `git`, `deploy`, and your app's `app.example.com`
- **your app** — a repo seeded with CI/CD, built and deployed per environment

Re-run `intentic apply` any time: it reads live state, fixes drift, and converges back to all-noop.

## What you declared vs. what intentic derived

Your `i.have.host` / `i.have.cloudflare` + `i.want.app` expand into the abstract *needs* an app requires — `source-control`, `docker-registry`, `infra-control`, `deployment-target`, `domain` — and intentic resolves the option catalog that meets them: Forgejo covers git + registry, Komodo the control plane, a Cloudflare Tunnel the domain. The result is one serializable desired-state graph, committed to git and reconciled. See [ARCHITECTURE.md](ARCHITECTURE.md) for the full intent → needs → desired state → reconcile flow.

## Capabilities

- **Reconcile & self-heal** — `intentic plan` classifies every node create/update/noop/delete against live state; `intentic apply` loops apply→read until the plan reads all-noop ("state reads true"). It is idempotent: drift is detected by reading reality and corrected on the next apply.

- **Teams & people** — declare users and teams; intentic creates a Forgejo org + team and Komodo RBAC, and grants each team its role on the apps it manages:
  ```ts
  const alice = i.want.user("alice", { username: "alice", email: "alice@example.com" });
  const platform = i.want.team("platform", { members: [alice], komodo: "execute" });
  i.want.app("my-app", { on: host, expose: cf, teams: [{ team: platform, role: "write" }], environments: { /* … */ } });
  ```

- **Multi-environment apps** — each environment gets its own branch, domain, env, and deployment:
  ```ts
  environments: {
      staging:    { domain: "staging.example.com", branch: "develop", env: { DATABASE_URL: env("STAGING_DATABASE_URL") } },
      production: { domain: "app.example.com",      branch: "main",    env: { DATABASE_URL: env("PRODUCTION_DATABASE_URL") } },
  }
  ```

- **Observability** — declare a shared SignOz service and point apps at it; intentic injects its OTLP endpoint into every deployment:
  ```ts
  const obs = i.want.service("obs", { kind: "signoz", on: host, expose: cf, domain: "signoz.example.com" });
  i.want.app("my-app", { on: host, expose: cf, observe: obs, environments: { /* … */ } });
  ```

- **Backups & restore** — point `i.have.backup` at a restic repo for scheduled, app-consistent snapshots of Forgejo + Komodo state; `intentic restore --snapshot <id>` recovers them and re-applies:
  ```ts
  i.have.backup("backup", {
      repo: "s3:s3.amazonaws.com/my-bucket/intentic",
      password: env("RESTIC_PASSWORD"),
      credentials: { AWS_ACCESS_KEY_ID: env("AWS_ACCESS_KEY_ID"), AWS_SECRET_ACCESS_KEY: env("AWS_SECRET_ACCESS_KEY") },
  });
  ```

- **Guarded upgrades** — set `updatePolicy: "guarded"` on a host (with a backup declared) and every stateful-service image bump runs as a transaction: snapshot → recreate on the new image → health-gate → auto-rollback of image *and* data on failure.
  ```ts
  const host = i.have.host("host", { address: "203.0.113.10", user: "deploy", sshKey: env("HOST_SSH_KEY"), updatePolicy: "guarded" });
  ```

- **Strict version locking** — every image intentic deploys is pinned `repo:tag@sha256:…` and recorded in `desired-state.json`. An upstream re-push of a tag cannot change what runs; a version moves only by a reviewed commit (Renovate opens the PR), and rollback is `git revert` + re-apply.

- **GitOps via `adopt`** — `intentic adopt` pushes your `intent` and `desired-state` repos into the Forgejo it just stood up and wires Forgejo Actions, so from then on `git push` → resolve → apply runs in CI.

- **Notifications** — declare a Discord bot with `i.have.discord` and wire an app's `notify`; intentic owns the guild, channels, and webhooks, and posts CI/CD and reconcile summaries.

- **Pluggable stack** — the default is the self-hosted Forgejo + Komodo stack. Declare `i.have.github` instead and apps source from GitHub with GitHub Actions + GHCR and deploy over SSH — no Forgejo, no Komodo.

## Getting started

```sh
pnpm install
pnpm build               # turbo build across packages

pnpm intentic --help     # the CLI (bin: intentic) — init · resolve · plan · apply · adopt · restore
pnpm intentic init       # scaffold the intent + desired-state repos
```

> Requires **Node 24** and **pnpm 11**. From this repo the CLI runs as `pnpm intentic <command>` (the first call builds `dist`, then runs incrementally). The full authoring reference is [examples/deploy.config.ts](examples/deploy.config.ts).

## Cloudflare API token

intentic discovers your zone and account from the token alone, so the only Cloudflare setup is a token with:

- **Account → Cloudflare Tunnel → Edit**
- **Zone → DNS → Edit**
- **Zone → Zone → Read**

**Security posture:** each host gets one Cloudflare Tunnel that connects *outbound* — no inbound ports are opened. SSH is used only for intentic's own control operations.

## Known limitations

- **Host-key trust** — the SSH adapter currently accepts any host key (no `hostVerifier`).
- **No orphan detection for Cloudflare resources yet** — records are stamped (`intentic.id=<id>`) for a future orphan pass, but the tunnel/route providers cannot yet enumerate stamped resources.
- **`plan` reads live infra** — the read-only preview queries the Cloudflare API and SSHes to the host to observe current state.

## Architecture & contributing

[ARCHITECTURE.md](ARCHITECTURE.md) covers the package layout, the intent-driven flow, the control plane vs application plane split, and the maintainer workflows — local end-to-end testing and the `demo:up` stand-up.

## License

MIT
