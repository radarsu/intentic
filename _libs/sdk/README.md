# @intentic/sdk

The authoring surface a user writes their `deploy.config.ts` against. A declaration uses `i.want.app` (what
you want); the host it runs on and the Cloudflare it's exposed through are the implicit reconciled inventory
(their connection values filled at the decision/PR step), not authored. The SDK captures the declaration and
runs the resolver pipeline. Depends on `@intentic/graph` + `@intentic/resolvers`.

**Key exports:** `defineCandidates` (build → every valid reconciliation-target artifact — the set the
controller chooses from); `defineStack` (one-shot → a single `DesiredStateGraph`, auto-picking or via
`preferKey`); `build` (declaration → `IntentSet`); the handle types (`App`, `Repo`, `Deployment`, …).

Authors import `env` (secret refs) from its true source, `@intentic/graph`. See
[/examples/deploy.config.ts](../../examples/deploy.config.ts) and [ARCHITECTURE.md](../../ARCHITECTURE.md).
