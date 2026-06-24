# @intentic/providers

The real Provider SPI implementations the engine reconciles against — the only seam between a compiled
graph and live infrastructure. Each provider does `read` (stateless introspection), `diff` (pure
decision), and `apply` (create/update) over SSH/Docker and the Forgejo/Komodo/Cloudflare HTTP APIs.
Depends on `@intentic/engine` (SPI types) + `@intentic/resolvers`.

**Key exports:** `createProviders` (assemble the full `ResourceType → Provider` map; inject fakes or real
deps via `ProviderDeps`); the individual `create*Provider` factories (`host`, `cloudflare`, `cf-route`,
`tunnel`, `forgejo`, `forgejo-runner`, `forgejo-notify`, `repo`, `komodo`, `komodo-notify`, `app`,
`deployment`, `deploy-hook`); the API adapters `forgejoApi` / `komodoApi` / `cloudflareApi` (+ their types)
and `fakeForgejoApi`; `sshExecutor` (+ `SshExecutor`/`SshSession`); `parseInputs` (zod input validation).
See [ARCHITECTURE.md](../../ARCHITECTURE.md).
