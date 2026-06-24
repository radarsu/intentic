# Architecture

intentic is **intent-driven deployment**: you declare *what you have* and *what you want*; the system
computes every valid way to satisfy that, picks one, and reconciles infrastructure until reality matches.

## The intent-driven flow

```
Intent ──► Needs ──► Options (catalog) ──► Candidates ──► Choose ──► Execute ──► (reads true)
```

1. **Intent** — a declaration authored with the SDK: `i.have.host(...)` / `i.have.cloudflare(...)` (what
   you have) and `i.want.app(...)` (what you want). Captured as a serializable `IntentSet`.
   ([_libs/sdk/src/stack.ts](_libs/sdk/src/stack.ts))
2. **Needs** — the abstract capabilities the intent requires, derived from it: `source-control`,
   `docker-registry`, `infra-control`, `deployment-target`, `domain`. (`deriveNeeds` in
   [_libs/resolvers/src/needs.ts](_libs/resolvers/src/needs.ts))
3. **Options** — a catalog of concrete things that satisfy capabilities; one option may cover several
   (Forgejo provides both source-control and docker-registry). (`defaultCatalog` in
   [_libs/resolvers/src/catalog.ts](_libs/resolvers/src/catalog.ts))
4. **Candidates** — every valid option-per-need combination, each compiled into one **reconciliation-target
   artifact** (a `DesiredStateGraph`). Today the catalog has one option per need, so there is exactly one
   candidate; the structure supports N (e.g. a future Gitlab option). (`generateCandidates` in
   [_libs/resolvers/src/candidate.ts](_libs/resolvers/src/candidate.ts), emitting nodes via
   [emit.ts](_libs/resolvers/src/emit.ts))
5. **Choose** — pick one candidate. Deterministic today (auto-pick / `preferKey`); the LLM-suggestion seam
   lands here later. (`choose` in [_libs/resolvers/src/choose.ts](_libs/resolvers/src/choose.ts))
6. **Execute** — apply the chosen artifact and re-read state, looping until a plan reads all-noop ("state
   reads true"). (`reconcile` in [_libs/engine/src/reconcile-loop.ts](_libs/engine/src/reconcile-loop.ts),
   over `apply`/`plan` and the Provider SPI)

A `DesiredStateGraph` (the artifact) is the central data structure: a serializable, dependency-ordered set
of resource nodes with refs, secrets, and readiness gates. ([_libs/graph/src/types.ts](_libs/graph/src/types.ts))

## Control plane vs application plane

- **Control plane** — stood up *before* any user intent exists: a standalone Gitea/Forgejo holding the
  `intent` and `reconciliation-target` repos. The controller bootstraps it, watches the intent repo, and on
  each push runs the flow above, committing the chosen artifact back to the target repo.
  ([_apps/controller/src/control-plane.ts](_apps/controller/src/control-plane.ts),
  [bootstrap.ts](_apps/controller/src/bootstrap.ts), [controller.ts](_apps/controller/src/controller.ts))
- **Application plane** — the per-host support stack (Forgejo/Komodo/runner, Cloudflare tunnel + DNS
  routes) *derived from* `i.want.app`. This is what the resolver emits and the engine reconciles onto owned
  infra. ([_libs/resolvers/src/platform.ts](_libs/resolvers/src/platform.ts),
  [_libs/providers/](_libs/providers/src/))

The two planes deliberately share code: the control-plane Forgejo reuses the same `forgejo` provider as the
application-plane one — they are different node instances, not different implementations.

## Packages

Dependency direction (one-way):

```
graph ──► resolvers ──► sdk
   └────► engine ──► providers ──► controller (app)
```

| Package | Tier | Role |
| --- | --- | --- |
| [`@intentic/graph`](_libs/graph) | lib | Product-agnostic IR: refs, secrets, readiness, `DesiredStateGraph`, and the compiler. |
| [`@intentic/resolvers`](_libs/resolvers) | lib | Intent → needs → catalog → candidates → choose; the closed `ResourceType` vocabulary and `OUTPUTS`. |
| [`@intentic/sdk`](_libs/sdk) | lib | Authoring surface (`i.have`/`i.want`); `defineStack` (one graph) and `defineCandidates` (the set). |
| [`@intentic/engine`](_libs/engine) | lib | Stateless reconcile engine: `plan`/`apply`, the Provider SPI, and the `reconcile` loop. |
| [`@intentic/providers`](_libs/providers) | lib | Real Provider SPI impls over SSH/Docker, Cloudflare, Forgejo, Komodo. |
| [`@intentic/controller`](_apps/controller) | **app** | The runnable product: bootstrap the control plane, watch intent, execute. CLI `bin: intentic`. |

## The intent contract

A pushed `deploy.config.ts` (see [/examples/deploy.config.ts](examples/deploy.config.ts)) must
`export const candidates = defineCandidates(...)` — the set the controller chooses from.
([evaluate-intent.ts](_apps/controller/src/evaluate-intent.ts)). `defineStack(...)` is the one-shot,
single-graph form used when a single deterministic graph is wanted directly.

## Conventions (so the layout is predictable)

- **One concept per file**, named for the concept (`reconcile-loop.ts`, `control-plane.ts`,
  `forgejo-api.ts`). Tests are **co-located** next to their source.
- **Test naming:** `*.test.ts` = unit; `*.engine.test.ts` = integration driven through the real engine;
  `*.e2e.test.ts` = gated real run (set `INTENTIC_E2E=1`; excluded from CI).
- **Tiers:** `_libs/` = libraries, `_apps/` = runnable products, `_tools/` = shared config. The
  pnpm-workspace glob is `_*/*`.
- **Imports:** import from the true source (no re-exports/aliases). The `@intentic/src` package export
  condition resolves workspace imports straight to `src/`, so agents can edit across packages without
  building.
- The compiled shape of the example/fixture is pinned by
  [_libs/sdk/src/deploy.config.test.ts](_libs/sdk/src/deploy.config.test.ts) against
  [_libs/sdk/src/__fixtures__/deploy.graph.ts](_libs/sdk/src/__fixtures__/deploy.graph.ts).

See [CLAUDE.md](CLAUDE.md) for the code-style rules every change must follow.
