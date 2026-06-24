# @intentic/need-resolver

The **need resolver**: turns an `IntentSet` into the abstract capabilities it requires. Owns the authored
intent shapes and the intent → needs derivation. Depends on `@intentic/graph`; consumed by
`@intentic/state-resolver` and `@intentic/sdk`.

**Key exports:** `resolveNeeds` + `Capability`/`Need`/`Plane` (the abstract capabilities an intent requires,
each on the control or application plane) + `needKey`; `IntentSet`/`HostIntent`/`CloudflareIntent`/`AppIntent`
(the authored intent) and the input shapes `HostInput`/`CloudflareInput`/`EnvironmentInput`/`NotifyInput`.
See [ARCHITECTURE.md](../../ARCHITECTURE.md).
