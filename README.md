# intentic-deploy

A pnpm + Turbo monorepo of TypeScript packages for solo-dev deployment.

## Packages

| Package | Description |
| --- | --- |
| [`@intentic/graph`](_libs/graph) | Product-agnostic desired-state IR: refs, secrets, readiness, the serializable graph, and the compiler. |
| [`@intentic/resolvers`](_libs/resolvers) | Computes intent into needs, the option catalog that meets them, and every valid reconciliation-target artifact — then chooses one. |
| [`@intentic/sdk`](_libs/sdk) | Authoring surface (`i.have` / `i.want`) and `defineStack`: build → resolve → compile. |
| [`@intentic/engine`](_libs/engine) | Stateless reconcile engine: `plan` / `apply` a `DesiredStateGraph` onto infra via the Provider SPI. |
| [`@intentic/providers`](_libs/providers) | Real reconcile providers over the engine SPI: `host` (SSH/Docker via `ssh2`), `cloudflare` (resolve owned zone → id), `tunnel` (Cloudflare Tunnel + `cloudflared` on the host), `cf-route` (proxied DNS CNAME). |
| [`@intentic/controller`](_libs/controller) | Intent-driven control plane: `bootstrap` a standalone Gitea/Forgejo with the intent + reconciliation-target repos, then `runController` watches the intent repo, computes + auto-picks a candidate, stores it, and reconciles it until state reads true. |

## Getting started

```sh
pnpm install
pnpm build         # turbo build across packages
pnpm test
pnpm libs:watch    # incremental TypeScript build in watch mode
```

> Requires **Node 24** and **pnpm 11**.

## Providers

Each host that exposes anything gets one Cloudflare Tunnel: `cloudflared` runs on the host (started over
SSH as a Docker container) and connects outbound, so no inbound ports are opened. The `tunnel` provider
owns the tunnel's aggregated ingress (`hostname → internal service URL`); each `cf-route` owns one public
hostname's proxied DNS CNAME pointing at the tunnel.

**Required Cloudflare API token scopes:** Account → Cloudflare Tunnel → Edit; Zone → DNS → Edit; Zone →
Zone → Read.

**Known limitations (v1):**

- **Ingress reachability** — the `cloudflared` container runs with `--network host` and must be able to
  dial each service's internal URL from the host.
- **Plan touches live infra (read-only)** — `plan` calls each provider's `read`, which queries the
  Cloudflare API and SSHes to the host to check the connector.
- **No orphan detection for Cloudflare resources** — the engine's `list` SPI receives no per-node
  credentials, so the `tunnel`/`cf-route` providers cannot enumerate stamped resources yet. Records are
  still stamped (`intentic.id=<id>` in the DNS comment) for a future orphan pass.
- **Public-health readiness ordering** — the platform services' `readyWhen` gates target public URLs,
  which only resolve once the tunnel + DNS exist; this surfaces when the forgejo/komodo/deployment
  providers land (not yet built).
- **Host-key trust** — the SSH adapter accepts any host key (no `hostVerifier`).

## Local end-to-end testing

`createProviders()` ([_libs/providers/src/providers.ts](_libs/providers/src/providers.ts)) assembles the
full `ResourceType → Provider` map — the single seam between a compiled graph and execution. Passing
fakes drives the whole suite in-memory ([suite.engine.test.ts](_libs/providers/src/suite.engine.test.ts));
passing nothing uses the real SSH/Cloudflare/Forgejo/Komodo implementations.

[local.e2e.test.ts](_libs/providers/src/local.e2e.test.ts) is a **manual, real** run: it boots a
Docker-in-Docker "host" ([test/host/Dockerfile](test/host/Dockerfile)) via `testcontainers`, reaches it
over SSH with a per-run generated key, and `apply`s the derived graph against it — Forgejo, the CI
runner, Komodo, the repo/app/deploy-hook, plus a **real Cloudflare zone/DNS/tunnel**. It asserts the
graph converges (`create`) and a second `apply` is all-`noop` (idempotency), then deletes the Cloudflare
resources it created. Tier 1 builds no app, so the deployment's runtime health gate is short-circuited.

It is gated behind `INTENTIC_E2E` and **excluded from `pnpm test` / CI** (needs a privileged Docker
daemon and live Cloudflare credentials). Run it with:

```sh
INTENTIC_E2E=1 \
CLOUDFLARE_API_TOKEN=...      # Account → Tunnel → Edit; Zone → DNS → Edit; Zone → Zone → Read
CLOUDFLARE_ACCOUNT_ID=... \
CLOUDFLARE_ZONE=example.com \ # a throwaway zone you own — DNS records + a tunnel are created and deleted
FORGEJO_ADMIN_PASSWORD=... \
KOMODO_ADMIN_PASSWORD=... \
KOMODO_WEBHOOK_SECRET=... \
pnpm --filter @intentic/providers e2e
```

> Networking: providers run nested containers with `--network host`, so the engine reaches services at
> the host's internal IP and port. This works from a Linux/WSL2 host (routable bridge IPs); on Docker
> Desktop (macOS/Windows) run the harness as a sibling container on the same network.

## License

MIT
