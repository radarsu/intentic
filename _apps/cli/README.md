# @intentic/cli

The **runnable product** (CLI `bin: intentic` + reconcile daemon) — the entrypoint that ties the whole
flow together. It bootstraps the control plane (a standalone Gitea/Forgejo holding the `intent` and
`reconciliation-target` repos), watches the intent repo, and on each push computes candidates, auto-picks
one, stores it in the target repo, and executes it until state reads true. Depends on `@intentic/engine`,
`@intentic/providers`, `@intentic/resolvers`, `@intentic/graph`.

**CLI:** `intentic control-plane up` (bootstrap) · `intentic control-plane watch` (daemon), built on
[stricli](https://github.com/bloomberg/stricli) with generated `--help` / `--version`. Control-plane config
comes from flags (`--host-address`, `--host-user`, `--host-port`, `--internal-ip`, `--domain`) that fall
back to env (`INTENTIC_HOST_ADDRESS`, `INTENTIC_HOST_USER`, `INTENTIC_HOST_PORT`,
`INTENTIC_CONTROL_INTERNAL_IP`, `INTENTIC_CONTROL_DOMAIN`); `watch` also takes `--poll-interval` /
`--max-iterations`. Secrets stay in env (`HOST_SSH_KEY` / `FORGEJO_ADMIN_PASSWORD`), resolved at apply time.

**Key exports:** `bootstrap` (+ `BootstrapOutcome`); `runController` / `runCycle` (+ `ControllerDeps`);
`buildControlPlaneGraph` + `ControlPlaneConfig`; `createControlRepoProvider` (the `control-repo` provider);
`evaluateIntentSource` (the pushed-config → `candidates` seam). See [ARCHITECTURE.md](../../ARCHITECTURE.md).
