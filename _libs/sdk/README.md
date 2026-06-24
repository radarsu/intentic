# @intentic/sdk

The authoring surface a user writes their `deploy.config.ts` against. A declaration uses `i.have.host` /
`i.have.cloudflare` (the inventory you have — the host apps run on and the Cloudflare account they're exposed
through) and `i.want.app` (what you want), wiring each app to its host/Cloudflare via `on` / `expose`. The
support stack each app needs (git+CI, deploy orchestrator, runner, tunnel, routes) is derived by the
resolvers. The SDK captures the declaration and runs the resolver pipeline. Depends on `@intentic/graph`,
`@intentic/need-resolver`, and `@intentic/state-resolver`.

**Key exports:** `defineIntent` (the authoring entry: declaration → `IntentSet`, which `intentic resolve`
turns into the desired state); `defineStack` (one-shot → a single `DesiredStateGraph`); the handle types
(`Host`, `Cloudflare`, `App`, `Repo`, `Deployment`, …).

Authors import `env` (secret refs) from its true source, `@intentic/graph`. See
[/examples/deploy.config.ts](../../examples/deploy.config.ts) and [ARCHITECTURE.md](../../ARCHITECTURE.md).
