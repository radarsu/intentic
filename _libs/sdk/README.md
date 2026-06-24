# @intentic/sdk

The authoring surface a user writes their `deploy.config.ts` against. A declaration uses `i.want.app` (what
you want); the host it runs on and the Cloudflare it's exposed through are the implicit reconciled inventory
(their connection values filled at the decision/PR step), not authored. The SDK captures the declaration and
runs the resolver pipeline. Depends on `@intentic/graph` + `@intentic/resolvers`.

**Key exports:** `defineIntent` (the authoring entry: declaration → `IntentSet`, which `intentic resolve`
turns into candidates and chooses from); `defineStack` (one-shot → a single `DesiredStateGraph`, auto-picking
or via `preferKey`); the handle types (`App`, `Repo`, `Deployment`, …).

Authors import `env` (secret refs) from its true source, `@intentic/graph`. See
[/examples/deploy.config.ts](../../examples/deploy.config.ts) and [ARCHITECTURE.md](../../ARCHITECTURE.md).
