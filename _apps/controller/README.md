# @intentic/controller

The **runnable product** (CLI `bin: intentic` + reconcile daemon) — the entrypoint that ties the whole
flow together. It bootstraps the control plane (a standalone Gitea/Forgejo holding the `intent` and
`reconciliation-target` repos), watches the intent repo, and on each push computes candidates, auto-picks
one, stores it in the target repo, and executes it until state reads true. Depends on `@intentic/engine`,
`@intentic/providers`, `@intentic/resolvers`, `@intentic/graph`.

**CLI:** `intentic control-plane up` (bootstrap) · `intentic control-plane watch` (daemon). Config is read
from env (`INTENTIC_HOST_ADDRESS`, `INTENTIC_CONTROL_INTERNAL_IP`, `INTENTIC_CONTROL_DOMAIN`, secrets via
`HOST_SSH_KEY` / `FORGEJO_ADMIN_PASSWORD`).

**Key exports:** `bootstrap` (+ `BootstrapOutcome`); `runController` / `runCycle` (+ `ControllerDeps`);
`buildControlPlaneGraph` + `ControlPlaneConfig`; `createControlRepoProvider` (the `control-repo` provider);
`evaluateIntentSource` (the pushed-config → `candidates` seam). See [ARCHITECTURE.md](../../ARCHITECTURE.md).
