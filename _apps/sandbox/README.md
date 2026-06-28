# @intentic/sandbox

The **per-project AI-agent dev daemon** — a Docker image that runs inside a project's sandbox container on the customer's host. It exposes a loopback HTTP API the runner drives: run a Claude Agent turn over the project's three repos, run the `intentic` CLI, do git operations, and report the dev-server preview. Ships to GHCR as `ghcr.io/radarsu/intentic/sandbox`. A private package (not published to npm).

## Responsibilities

- Serve the daemon API (`/agent`, `/intentic`, `/git/:repo/*`, `/preview`, `/health`) bound to the container loopback — the runner reaches it; it is itself unauthenticated (the runner owns platform auth).
- Run one Claude Agent turn (`runAgent`) over the workspace, streaming typed `AgentEvent`s as SSE `data:` frames.
- Run the `intentic` CLI in-workspace and stream its ndjson lines; commit/push the repos.
- Manage the app dev server and report preview status.

## Key files

- [src/daemon.ts](src/daemon.ts) — the Hono HTTP API + request schemas.
- [src/agent.ts](src/agent.ts) — `runAgent` + the `AgentEvent` union (`session`/`delta`/`tool`/`error`/`done`); wraps the Claude Agent SDK.
- [src/dev-server.ts](src/dev-server.ts) — spawns/watches the app dev server; `/preview` status.
- [src/intentic-runner.ts](src/intentic-runner.ts) — runs the `intentic` CLI and parses its ndjson.
- [src/git.ts](src/git.ts) — status/commit/push; [src/workspace.ts](src/workspace.ts) — the three-repo layout (intent / desired-state / monorepo).
- [src/main.ts](src/main.ts) — entrypoint: builds the workspace + dev server and serves the daemon.

## How it fits

The agent half of the dev plane. [`@intentic/runner`](../runner) starts and relays to this container; the platform's chat relay sends a prompt **plus the user's Claude OAuth token per turn** in the `/agent` request body, which `runAgent` injects into the SDK's per-query env.

## Conventions & gotchas

- Credentials are **never** baked in or stored: the OAuth token arrives per-turn in the request body and is only passed to the SDK for that call (no container-env secret).
- The daemon trusts its caller — it must stay loopback-only; exposure is the runner's responsibility.
- Built on Hono + the Claude Agent SDK + zod; `runAgent`'s `QueryFn` is injectable so co-located `*.test.ts` run without the SDK or network.
