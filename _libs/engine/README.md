# @intentic/engine

The stateless reconcile engine. Walks a `DesiredStateGraph` in dependency order and converges it through
the **Provider SPI** — never constructing providers itself, only consuming a `ResourceType → Provider`
map. Depends on `@intentic/graph` + `@intentic/resources` (the `ResourceType`/`OUTPUTS` vocabulary); the real providers live in `@intentic/providers`.

**Key exports:** `apply` (converge once: read → diff → create/update/noop, gating on readiness); `plan`
(dry run); `reconcile` + `ConvergeResult` (execute until a plan reads all-noop — "state reads true");
`Provider` / `Providers` / `Observed` / `DiffResult` / `ProviderContext` (the SPI); `EngineConfig`,
`ApplyOutcome`, `Step`, `Orphan`; `httpProbe` / `waitReady` (readiness); `createFakeProviders` (in-memory
SPI for tests). See [ARCHITECTURE.md](../../ARCHITECTURE.md).
