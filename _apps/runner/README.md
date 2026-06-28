# @intentic/runner

The **host-side runner** — a Docker image that runs on the customer's server. It fronts the project's preview URLs and (when the control plane is wired) dials the platform over an outbound WebSocket to serve sandbox commands. One runner per host; it manages one AI-agent sandbox per project. Ships to GHCR as `ghcr.io/radarsu/intentic/runner`. A private package (not published to npm).

## Responsibilities

- Run the **preview reverse proxy**: the wildcard tunnel route `*.preview.<zone>` lands here, and the proxy fans each `<project>.preview.<zone>` host out to the right sandbox dev server.
- Dial an **outbound WSS channel** to the platform gateway (the host opens no inbound port) and serve `RunnerCommand`s by driving the sandbox.
- Manage the sandbox lifecycle on the host Docker daemon (ensure/remove/status) and relay HTTP to the sandbox daemon.
- It holds **no** Claude credentials — the platform injects the user's token per turn inside the relay command.

## Key files

- [src/main.ts](src/main.ts) — entrypoint: always starts the preview proxy; starts the channel when `PLATFORM_URL` + `RUNNER_TOKEN` are set.
- [src/channel.ts](src/channel.ts) — the outbound WS client: dials `${PLATFORM_URL}?token=…`, runs `dispatch`, streams events back, reconnects with capped backoff.
- [src/dispatch.ts](src/dispatch.ts) — the `RunnerCommand` / `RunnerEvent` protocol (`ensure`/`remove`/`status`/`relay`) and `dispatch`.
- [src/control.ts](src/control.ts) — `createController` / `Controller`: lifecycle + the daemon `relay` (line-framed).
- [src/sandbox-manager.ts](src/sandbox-manager.ts) / [src/docker.ts](src/docker.ts) — `ensureSandbox`/`removeSandbox`, `SandboxSpec`, and the Docker CLI wrapper.
- [src/proxy-server.ts](src/proxy-server.ts) / [src/preview-proxy.ts](src/preview-proxy.ts) — the preview HTTP proxy and host→project resolution.

## How it fits

The runtime half of the dev plane. The platform provisions it as a `workspace` node (see [`@intentic/state-resolver`](../../_libs/state-resolver) + the workspace provider in [`@intentic/providers`](../../_libs/providers)), hands it its gateway URL + token, and drives it from `intentic-platform`'s runner gateway. It speaks to [`@intentic/sandbox`](../sandbox) over the host network.

## Conventions & gotchas

- The token rides as a **query param** (the WHATWG `WebSocket` client can't set headers) — always over WSS.
- The runner is the dialer; nothing reaches the host inbound. The sandbox daemon is reached by container name, not published to the host.
- Built on Hono + the Node global `WebSocket` (Node 24); co-located `*.test.ts` use fake sockets/controllers/Docker.
