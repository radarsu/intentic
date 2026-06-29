#!/bin/sh
# intentic connect — run the AI-agent workspace runner on THIS machine and dial it back to an intentic
# platform, so a user without their own server can drive a sandbox from their PC.
#
# How: the platform mints a per-project runner token and hands you this one-liner. The script starts the
# published runner image as a long-lived container that holds the local docker socket (so it can spawn the
# project's sandbox) and dials the platform's WSS gateway OUTBOUND with the token — no inbound port needed.
# Once connected, the platform's setup gate flips to "ready" on its own. This is the same container the
# server-based `i.want.workspace` provider runs, minus the Cloudflare preview tunnel (a local PC has no zone).
#
# Usage (env or positional args):
#   PLATFORM_URL=wss://platform.example/runner/gateway RUNNER_TOKEN=<token> ./connect.sh
#   ./connect.sh <PLATFORM_URL> <RUNNER_TOKEN>
#   curl -fsSL https://raw.githubusercontent.com/radarsu/intentic/main/scripts/connect.sh | PLATFORM_URL=… RUNNER_TOKEN=… sh
#
# Required (env or positional):
#   PLATFORM_URL    the platform's runner gateway, e.g. wss://platform.example/runner/gateway
#   RUNNER_TOKEN    the per-project token the platform's setup screen shows you
#
# Optional env:
#   RUNNER_IMAGE    runner image to run (default: ghcr.io/radarsu/intentic/runner:latest)
#   SANDBOX_IMAGE   sandbox image the runner spawns (default: ghcr.io/radarsu/intentic/sandbox:latest)
#   PREVIEW_PORT    local preview proxy port published by the runner (default: 8088)
# POSIX sh (this is piped into `sh`, which is dash on Debian/Ubuntu/WSL — no `pipefail`).
set -eu

PLATFORM_URL="${PLATFORM_URL:-${1:-}}"
RUNNER_TOKEN="${RUNNER_TOKEN:-${2:-}}"
RUNNER_IMAGE="${RUNNER_IMAGE:-ghcr.io/radarsu/intentic/runner:latest}"
SANDBOX_IMAGE="${SANDBOX_IMAGE:-ghcr.io/radarsu/intentic/sandbox:latest}"
PREVIEW_PORT="${PREVIEW_PORT:-8088}"

CONTAINER="intentic-runner"
NETWORK="intentic-workspace"

if ! command -v docker >/dev/null 2>&1; then
    echo "error: docker is not installed. Install Docker Engine (Linux) or Docker Desktop, then re-run." >&2
    exit 1
fi
if ! docker info >/dev/null 2>&1; then
    echo "error: the docker daemon is not running. Start Docker, then re-run." >&2
    exit 1
fi
if [ -z "$PLATFORM_URL" ] || [ -z "$RUNNER_TOKEN" ]; then
    echo "error: PLATFORM_URL and RUNNER_TOKEN are required (env or positional args)." >&2
    exit 1
fi

# The runner reaches each sandbox by container name on this shared network; create it before the run.
docker network inspect "$NETWORK" >/dev/null 2>&1 || docker network create "$NETWORK" >/dev/null
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

# --user root: the runner manages sandboxes through the mounted docker socket (its default non-root user gets
# "permission denied" on /var/run/docker.sock). --add-host lets a self-hosted platform on the same machine be
# reached at host.docker.internal (Docker Desktop resolves it automatically; harmless against a remote wss://).
docker run -d --restart unless-stopped --user root --name "$CONTAINER" \
    --network "$NETWORK" \
    --add-host host.docker.internal:host-gateway \
    -p "${PREVIEW_PORT}:${PREVIEW_PORT}" \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -e PREVIEW_PORT="$PREVIEW_PORT" \
    -e SANDBOX_IMAGE="$SANDBOX_IMAGE" \
    -e PLATFORM_URL="$PLATFORM_URL" \
    -e RUNNER_TOKEN="$RUNNER_TOKEN" \
    "$RUNNER_IMAGE" >/dev/null

echo "intentic runner started and dialing ${PLATFORM_URL}."
echo "Return to the platform — setup will continue automatically once it connects."
echo "Logs: docker logs -f ${CONTAINER}   Stop: docker rm -f ${CONTAINER}"
