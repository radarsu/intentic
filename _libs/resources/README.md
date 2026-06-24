# @intentic/resources

The closed **resource vocabulary** shared between the state resolver (which emits these kinds), the engine
(which reconciles them), and the providers (which implement them). The graph IR treats a node's `type` as an
opaque string; this package is the authority on which kinds exist and what each produces. Depends on
`@intentic/graph`.

**Key exports:** `ResourceType` (the closed union of resource kinds) + `ResolvedNode` (a `RawNode` whose
`type` is constrained to it); `OUTPUTS` (the outputs each kind produces). See
[ARCHITECTURE.md](../../ARCHITECTURE.md).
