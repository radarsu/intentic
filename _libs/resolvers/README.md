# @intentic/resolvers

Turns an `IntentSet` into desired-state artifacts. Owns the **needs → options → candidates →
choose** pipeline and the closed `ResourceType` vocabulary. Depends on `@intentic/graph`; consumed by
`@intentic/sdk`.

**Key exports:** `deriveNeeds` + `Capability`/`Need` (the abstract capabilities an intent requires);
`defaultCatalog` + `Catalog`/`Option` (what satisfies them); `enumerateAssignments` / `generateCandidates`
+ `Candidate` (every valid combination, compiled to a graph); `choose` (pick one); `emit` (build the nodes
for one assignment); `resolvePlatform` / `resolveApp` (the application-plane support stack); `OUTPUTS` +
`ResourceType`; `IntentSet` and input types; `adminUsername` and id helpers. See
[ARCHITECTURE.md](../../ARCHITECTURE.md).
