# @intentic/cli

The **runnable product** — the `intentic` CLI (`bin: intentic`). It turns a local intent file into a
desired-state artifact and executes it, with no remote control plane required. Depends on
`@intentic/engine`, `@intentic/providers`, `@intentic/need-resolver`, `@intentic/state-resolver`, `@intentic/graph`.

## Local control plane

The "control plane" is two local git repos: an **intent** repo holding `deploy.config.ts`, and a
**desired-state** repo holding the generated artifact (`desired-state.json`) and the
execution record (`status.json`). `intentic init` scaffolds both.

## Commands

Built on [stricli](https://github.com/bloomberg/stricli) with generated `--help` / `--version`.

- `intentic init [--dir .]` — scaffold the `intent` and `desired-state` git repos (intent seeded
  with a starter `deploy.config.ts`).
- `intentic resolve [--config deploy.config.ts] [--out desired-state.json]` —
  load the intent, resolve it to a `DesiredStateGraph`, and write it. Pure: no secrets, no infra access.
- `intentic plan [--artifact desired-state.json]` — read-only preview of what `apply` would
  create/update.
- `intentic apply [--artifact desired-state.json] [--max-iterations 5]` — reconcile the artifact
  until state reads true, writing `status.json` beside it. Deploy-target secrets (e.g. `HOST_SSH_KEY`,
  `CLOUDFLARE_API_TOKEN`) are read from the environment at apply time.

## Workflow

```sh
intentic init
cd intent && intentic resolve --out ../desired-state/desired-state.json
cd ../desired-state && HOST_SSH_KEY=… CLOUDFLARE_API_TOKEN=… intentic apply
```

> A `deploy.config.ts` imports `@intentic/sdk` + `@intentic/graph`, so the project it lives in must have
> them installed. `apply` reconciles the per-host platform (Forgejo/Komodo/runner, Cloudflare tunnel + DNS)
> as ordinary nodes in the artifact — a future "PR-managed" phase (a remote Forgejo watching the intent
> repo) would layer on top of this same flow.

**Key exports:** `loadIntent`; `readArtifact` / `writeArtifact` / `writeStatus`; `scaffold`; the
`CONFIG_FILE` / `ARTIFACT_FILE` / `STATUS_FILE` constants. See [ARCHITECTURE.md](../../ARCHITECTURE.md).
