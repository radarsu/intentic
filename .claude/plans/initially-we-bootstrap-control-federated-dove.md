# Plan: `intentic adopt` — push local control-plane repos to remote Forgejo

## Context

The bootstrap flow today is `init` → `resolve` → `apply`. `init` scaffolds two **local** git repos
([init.ts:80](_apps/cli/src/init.ts#L80)): `intent/` (holds `deploy.config.ts`) and `desired-state/`
(holds the artifact `resolve` writes and the status/access `apply` writes). Each is created with `git init`,
but they have **no commits and no remote** — nothing ever connects them to a git host.

`apply` provisions Forgejo on the target host ([forgejo.ts](_libs/providers/src/forgejo.ts)). Its public URL
`https://git.<zone>` is reachable from the CLI over the Cloudflare tunnel — the app-`repo` provider already
talks to it from the CLI using admin Basic auth ([app.ts:23](_libs/state-resolver/src/app.ts#L23),
[repo.ts](_libs/providers/src/repo.ts)). So once `apply` has run, everything needed to push the local repos
into Forgejo is on disk: the artifact names the Forgejo node (domain + admin user), and the admin password is
the generated secret `FORGEJO_ADMIN_PASSWORD` in `desired-state/.secrets.json`.

**Goal:** a new `intentic adopt` command that, after `apply`, creates `intent` and `desired-state` repos in
Forgejo, auto-commits pending local changes, wires up `origin`, and pushes — turning the two local repos into
remote-backed, PR-manageable control-plane repos.

## Approach

A standalone CLI command, fully self-contained from the artifact + `.secrets.json` (no need to re-run apply).
Pushing is done with real `git` over HTTPS (preserves history, handles arbitrary file trees) using the
authenticated admin identity. Credentials are passed per-push via `-c http.extraHeader=...` so they are
**never persisted** into `.git/config` (the remote URL stays clean) — matching the codebase's "auth flows
per-call, never baked in" convention.

### 1. Add `autoInit` to `createRepo` — [_libs/providers/src/forgejo-api.ts](_libs/providers/src/forgejo-api.ts)

`createRepo` currently hardcodes `auto_init: true` ([forgejo-api.ts:152](_libs/providers/src/forgejo-api.ts#L152)).
An `auto_init` repo has an initial commit that conflicts with pushing local history, so `adopt` needs to create
empty repos. Add a required `autoInit: boolean` field to the `createRepo` args (interface + impl), and update
the one caller — the app-`repo` provider — to pass `autoInit: true`
([repo.ts:61](_libs/providers/src/repo.ts#L61)). (Clean breaking change; no optional/compat per CLAUDE.md.)

### 2. New module `_apps/cli/src/adopt.ts`

Export `adoptRepos`, injectable for testing (`api: ForgejoApi = forgejoApi`, `git` runner defaulting to a
`promisify(execFile)`-based helper, mirroring [init.ts:8](_apps/cli/src/init.ts#L8)):

```
adoptRepos({ baseUrl, user, password, repos: [{dir, name}], log })
```

For each `{ dir, name }`:
1. `git -C <dir> add -A`; if `git status --porcelain` is non-empty, commit with an intentic identity
   (`-c user.name=<user> -c user.email=<user>@<domain> commit -m "intentic adopt"`) so it works without
   any global git config.
2. `git -C <dir> branch -M main` — normalize the branch (init's default may be `master`); Forgejo app repos
   use `main`.
3. Ensure the remote repo exists: `api.findRepo(...)`; if `undefined`, `api.createRepo({ ..., private: true,
   autoInit: false })`.
4. Wire `origin` to the **clean** clone URL `${baseUrl}/${user}/${name}.git`: `git remote set-url origin` if
   it already exists, else `git remote add origin` (detect via a quiet `git remote get-url origin`).
5. Push with credentials only on the command line:
   `git -C <dir> -c "http.extraHeader=AUTHORIZATION: basic <base64(user:password)>" push -u origin main`.

Errors propagate (CLAUDE.md) — a `git`/network failure surfaces directly.

### 3. Register the `adopt` command — [_apps/cli/src/app.ts](_apps/cli/src/app.ts)

Add an `adopt` command (one `--artifact` flag, default `ARTIFACT_PATH`) to the route map at
[app.ts:154](_apps/cli/src/app.ts#L154). Handler:
- `targetDir = dirname(artifact)`; `intentDir = join(dirname(targetDir), INTENT_DIR)` (the scaffold layout).
- `loadEnvFile(targetDir)`, then `readArtifact(artifact)`.
- Find the node with `type === "forgejo"`; if none, throw `run \`intentic apply\` first`.
- From its inputs: `domain`, `adminUser`; resolve `adminPassword` via `secretRef(node.inputs["adminPassword"])`
  ([secrets.ts](_apps/cli/src/secrets.ts), reused by [access.ts:41](_apps/cli/src/access.ts#L41)) — read the
  value from `readGeneratedSecrets(targetDir)` for a `generated` ref, else `process.env`.
- Call `adoptRepos` with `baseUrl: https://${domain}`, `user: adminUser`, the password, and the two repos
  `[{ dir: intentDir, name: INTENT_DIR }, { dir: targetDir, name: TARGET_DIR }]`.
- Print the resulting clone URLs.

Reused helpers: `INTENT_DIR`/`TARGET_DIR`/`ARTIFACT_PATH`/`readArtifact`/`loadEnvFile`
([artifact.ts](_apps/cli/src/artifact.ts)), `readGeneratedSecrets`
([generated-secrets.ts:44](_apps/cli/src/generated-secrets.ts#L44)), `secretRef`, `forgejoApi`.

### Notes / safety
- Secrets stay out of the push: `desired-state/.gitignore` already excludes `.env` + `.secrets.json`
  ([init.ts:40](_apps/cli/src/init.ts#L40)); the intent repo holds no secret values.
- No force-push — intentic is the sole writer of these repos, so pushes fast-forward.

## Files

- `_libs/providers/src/forgejo-api.ts` — add `autoInit` to `createRepo`.
- `_libs/providers/src/repo.ts` — pass `autoInit: true`.
- `_apps/cli/src/adopt.ts` — **new** orchestration module.
- `_apps/cli/src/app.ts` — register `adopt` command.

## Verification

- **Unit** (`_apps/cli/src/adopt.test.ts`): drive `adoptRepos` with a fake `ForgejoApi` and a fake `git`
  runner; assert it commits when dirty, creates the repo only when `findRepo` returns `undefined` (with
  `autoInit: false`), sets `origin` to the clean URL, and pushes `main` with the `http.extraHeader` arg
  (no creds in the remote URL). Add a `createRepo` `autoInit` case to the existing forgejo-api tests.
- **End-to-end (manual, against the demo):** run the existing demo bootstrap
  (`pnpm demo up` — [demo.ts](_apps/cli/src/demo.ts)), then from the scaffolded workspace run
  `intentic adopt --artifact <workspace>/desired-state/desired-state.json`. Confirm `intent` and
  `desired-state` repos appear under the `intentic` user in Forgejo (`https://git.<zone>` or the local
  `http://127.0.0.1:3000`) with the expected files and history, and that re-running `adopt` after another
  `resolve`/`apply` pushes the new desired-state commit (idempotent).
