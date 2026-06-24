# Architecture

intentic is **intent-driven deployment**: you declare *what you want*; the system computes every valid way
to satisfy that, picks one, and reconciles infrastructure until reality matches. The things you "have" (the
host it runs on, the Cloudflare it's exposed through) are not authored — they are reconciled resources in
the target artifact, their connection values filled at the decision/PR step.

## The intent-driven flow

```
Intent ──► Needs ──► Options (catalog) ──► Candidates ──► Choose ──► Execute ──► (reads true)
```

1. **Intent** — a declaration authored with the SDK: `i.want.app(...)` (what you want). Captured as a
   serializable `IntentSet`. The host and Cloudflare are the implicit reconciled inventory (see
   [_libs/resolvers/src/inventory.ts](_libs/resolvers/src/inventory.ts)), so the intent carries only apps.
   ([_libs/sdk/src/stack.ts](_libs/sdk/src/stack.ts))
2. **Needs** — the abstract capabilities the intent requires, derived from it: `source-control`,
   `docker-registry`, `infra-control`, `deployment-target`, `domain`. (`deriveNeeds` in
   [_libs/resolvers/src/needs.ts](_libs/resolvers/src/needs.ts))
3. **Options** — a catalog of concrete things that satisfy capabilities; one option may cover several
   (Forgejo provides both source-control and docker-registry). (`defaultCatalog` in
   [_libs/resolvers/src/catalog.ts](_libs/resolvers/src/catalog.ts))
4. **Candidates** — every valid option-per-need combination, each compiled into one **desired-state
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

- **Control plane** — two local git repos: an `intent` repo holding `deploy.config.ts` and a
  `desired-state` repo holding the chosen artifact + execution status. `intentic resolve` runs the
  flow above and writes the artifact; `intentic apply` executes it. A remote, PR-managed control plane (a
  standalone Forgejo watching the intent repo) is a planned later evolution of this same flow.
  ([_apps/cli/src/resolve.ts](_apps/cli/src/resolve.ts), [artifact.ts](_apps/cli/src/artifact.ts),
  [app.ts](_apps/cli/src/app.ts))
- **Application plane** — the per-host support stack (Forgejo/Komodo/runner, Cloudflare tunnel + DNS
  routes) *derived from* `i.want.app`. This is what the resolver emits and the engine reconciles onto owned
  infra. ([_libs/resolvers/src/platform.ts](_libs/resolvers/src/platform.ts),
  [_libs/providers/](_libs/providers/src/))

The application plane is self-contained: its per-host Forgejo is just another reconciled node, so `apply`
needs no pre-existing control plane. A future remote control plane would reuse the same `forgejo` provider —
a different node instance, not a different implementation.

## Packages

Dependency direction (one-way):

```
graph ──► resolvers ──► sdk
   └────► engine ──► providers ──► cli (app)
```

| Package | Tier | Role |
| --- | --- | --- |
| [`@intentic/graph`](_libs/graph) | lib | Product-agnostic IR: refs, secrets, readiness, `DesiredStateGraph`, and the compiler. |
| [`@intentic/resolvers`](_libs/resolvers) | lib | Intent → needs → catalog → candidates → choose; the closed `ResourceType` vocabulary and `OUTPUTS`. |
| [`@intentic/sdk`](_libs/sdk) | lib | Authoring surface (`i.want.app`); `defineIntent` (→ `IntentSet`) and `defineStack` (one graph). |
| [`@intentic/engine`](_libs/engine) | lib | Stateless reconcile engine: `plan`/`apply`, the Provider SPI, and the `reconcile` loop. |
| [`@intentic/providers`](_libs/providers) | lib | Real Provider SPI impls over SSH/Docker, Cloudflare, Forgejo, Komodo. |
| [`@intentic/cli`](_apps/cli) | **app** | The runnable product: `init` local repos, `resolve` intent → artifact, `apply` it. CLI `bin: intentic`. |

## The intent contract

A local `deploy.config.ts` (see [/examples/deploy.config.ts](examples/deploy.config.ts)) must
`export const intent = defineIntent(...)`; `resolve` generates the candidates from it and chooses one
([resolve.ts](_apps/cli/src/resolve.ts)). `defineStack(...)` is the one-shot,
single-graph form used when a single deterministic graph is wanted directly.

## Conventions (so the layout is predictable)

- **One concept per file**, named for the concept (`reconcile-loop.ts`, `resolve.ts`,
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
