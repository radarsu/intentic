# puristic-deploy

A pnpm + Turbo monorepo of TypeScript packages for solo-dev deployment.

## Packages

| Package | Description |
| --- | --- |
| [`@puristic/deploy-protocol`](_libs/protocol) | Product-agnostic desired-state IR: refs, secrets, readiness, the serializable graph, and the compiler. |
| [`@puristic/deploy-resolvers`](_libs/resolvers) | Resolves intent into concrete resources — the app resolver derives the Forgejo/Komodo/Cloudflare support stack. |
| [`@puristic/deploy-core`](_libs/core) | Authoring surface (`i.have` / `i.want`) and `defineStack`: build → resolve → compile. |
| [`@puristic/deploy-engine`](_libs/engine) | Stateless reconcile engine: `plan` / `apply` a `DesiredStateGraph` onto infra via the Provider SPI. |
| [`@puristic/deploy-providers`](_libs/providers) | Real reconcile providers over the engine SPI: `host` (SSH/Docker via `ssh2`), `cloudflare` (resolve owned zone → id), `tunnel` (Cloudflare Tunnel + `cloudflared` on the host), `cf-route` (proxied DNS CNAME). |

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
  still stamped (`puristic.id=<id>` in the DNS comment) for a future orphan pass.
- **Public-health readiness ordering** — the platform services' `readyWhen` gates target public URLs,
  which only resolve once the tunnel + DNS exist; this surfaces when the forgejo/komodo/deployment
  providers land (not yet built).
- **Host-key trust** — the SSH adapter accepts any host key (no `hostVerifier`).

## License

MIT
