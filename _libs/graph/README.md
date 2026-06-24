# @intentic/graph

Product-agnostic desired-state IR and its compiler — the data structure everything else is built around.
A node's `type` is an opaque string here; the closed vocabulary lives in `@intentic/resolvers`. This is
the base of the dependency graph (depended on by every other package).

**Key exports:** `DesiredStateGraph` / `RawNode` / `ResourceNode` / `Ref` / `SecretRef` / `Readiness`
types; `compile` (RawNode map → graph), `toNodeMap`, `linearize` (topological order); `makeRef` / `refKey`
/ `isRef`, `env` (env-sourced secret), `httpOk` (readiness gate); `formatStamp` / `parseStamp` (ownership
stamps). See [ARCHITECTURE.md](../../ARCHITECTURE.md).
