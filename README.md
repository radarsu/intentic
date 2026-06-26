# intentic

Intentic is infrastructure as intent for self-hosters. You declare what you want — an app, a domain, the things it needs — plus the handful of assets only you can provide (your server, your DNS account). Intentic derives everything in between: it picks and wires the providers (source control, a deployer, a container runtime), resolves your intent into a desired-state graph, and runs a reconcile loop that drives your real infrastructure toward that desired state, fixing drift until reality matches.

Choose a declarative, versioned source of truth instead of clicking through dashboards. With intentic you never wire the integrations yourself — you declare clean interfaces and Intentic does the gluing, derived from code intent, reviewed through git, no jumping between apps.

If something is measurable, observable and reversible - it belongs to Intentic.

## Packages

| Package | Description |
| --- | --- |
| [`@intentic/graph`](_libs/graph) | Product-agnostic desired-state IR: refs, secrets, readiness, the serializable graph, and the compiler. |
| [`@intentic/resources`](_libs/resources) | The closed resource vocabulary shared by the state resolver, engine, and providers: `ResourceType`, `ResolvedNode`, `OUTPUTS`. |
| [`@intentic/need-resolver`](_libs/need-resolver) | The need resolver: intent → needs. The authored intent/input shapes, `resolveNeeds`, `Capability`/`Need`/`Plane`. |
| [`@intentic/state-resolver`](_libs/state-resolver) | The state resolver: needs → desired state, via the option catalog that meets them. |
| [`@intentic/sdk`](_libs/sdk) | Authoring surface (`i.have.host` / `i.have.cloudflare` + `i.want.app`): `defineIntent` → `IntentSet`, `defineStack` → one graph. |
| [`@intentic/engine`](_libs/engine) | Stateless reconcile engine: `plan` / `apply` a `DesiredStateGraph` onto infra via the Provider SPI. |
| [`@intentic/providers`](_libs/providers) | Real reconcile providers over the engine SPI: `host` (SSH/Docker via `ssh2`), `cloudflare` (resolve owned zone → id), `tunnel` (Cloudflare Tunnel + `cloudflared` on the host), `cf-route` (proxied DNS CNAME). |
| [`@intentic/cli`](_apps/cli) | The runnable product (`bin: intentic`): `resolve` a local `deploy.config.ts` into a desired-state artifact and `apply` it until state reads true; `init` scaffolds the two local git repos. |

## Getting started

```sh
pnpm install
pnpm build         # turbo build across packages
pnpm test
pnpm libs:watch    # incremental TypeScript build in watch mode

# run the CLI from the repo root (first call builds dist via tsc, then incremental)
pnpm intentic --help
pnpm intentic init                   # scaffold intent + desired-state git repos
pnpm intentic resolve                # deploy.config.ts -> desired-state.json
pnpm intentic apply                  # execute the artifact until state reads true
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
daemon and live Cloudflare credentials). Run it from the repo root with `pnpm e2e`, which builds the
libs, sets `INTENTIC_E2E=1` for you, and fails loudly if any secret below is missing:

```sh
CLOUDFLARE_API_TOKEN=...      # Account → Tunnel → Edit; Zone → DNS → Edit; Zone → Zone → Read
CLOUDFLARE_ACCOUNT_ID=... \
CLOUDFLARE_ZONE=example.com \ # a throwaway zone you own — DNS records + a tunnel are created and deleted
FORGEJO_ADMIN_PASSWORD=... \
KOMODO_ADMIN_PASSWORD=... \
KOMODO_WEBHOOK_SECRET=... \
pnpm e2e
```

> Networking: providers run nested containers with `--network host`, so the engine reaches services at
> the host's internal IP and port. This works from a Linux/WSL2 host (routable bridge IPs); on Docker
> Desktop (macOS/Windows) run the harness as a sibling container on the same network.

## License

MIT
