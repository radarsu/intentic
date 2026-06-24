# @intentic/state-resolver

The **state resolver**: turns an `IntentSet` into the desired state (a `DesiredStateGraph`). It assigns each
need its catalog option and compiles the emitted nodes into one graph. Depends on `@intentic/graph`,
`@intentic/need-resolver` (needs), and `@intentic/resources` (the resource vocabulary); consumed by
`@intentic/sdk`.

**Key exports:** `resolveState` (compile the desired-state graph from an intent); `defaultCatalog` +
`Catalog`/`Option` (what satisfies each capability); `emit` + `Assignment` (build the nodes for one
assignment); `resolvePlatform` / `resolveApp` (the application-plane support stack); `adminUsername` and id
helpers. See [ARCHITECTURE.md](../../ARCHITECTURE.md).
