# @intentic/sdk

The authoring surface a user writes their `deploy.config.ts` against. A declaration uses `i.have.host` /
`i.have.cloudflare` (what you have) and `i.want.app` (what you want); the SDK captures it and runs the
resolver pipeline. Depends on `@intentic/graph` + `@intentic/resolvers`.

**Key exports:** `defineCandidates` (build → every valid reconciliation-target artifact — the set the
controller chooses from); `defineStack` (one-shot → a single `DesiredStateGraph`, auto-picking or via
`preferKey`); `build` (declaration → `IntentSet`); the handle types (`Host`, `Cloudflare`, `App`, …).

Authors import `env` (secret refs) from its true source, `@intentic/graph`. See
[/examples/deploy.config.ts](../../examples/deploy.config.ts) and [ARCHITECTURE.md](../../ARCHITECTURE.md).
