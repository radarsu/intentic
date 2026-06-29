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
#   RUNNER_IMAGE    runner image to run (default: ghcr.io/radarsu/intentic/runner:0.1.0)
#   SANDBOX_IMAGE   sandbox image the runner spawns (default: ghcr.io/radarsu/intentic/sandbox:0.1.0)
#   PREVIEW_PORT    local preview proxy port published by the runner (default: 8088)
#   SELF_HOST       when set (the platform's curl one-liner sets SELF_HOST=1), wire THIS machine as a deploy
#                   target: a dedicated service user in the docker group + a generated SSH key the sandbox uses
#                   to reach the host back at host.docker.internal. Needs root (server, Linux only).
#   SELF_HOST_USER  the service user to create/use for self-host (default: intentic).
# POSIX sh (this is piped into `sh`, which is dash on Debian/Ubuntu/WSL — no `pipefail`).
set -eu

PLATFORM_URL="${PLATFORM_URL:-${1:-}}"
RUNNER_TOKEN="${RUNNER_TOKEN:-${2:-}}"
RUNNER_IMAGE="${RUNNER_IMAGE:-ghcr.io/radarsu/intentic/runner:0.1.0}"
SANDBOX_IMAGE="${SANDBOX_IMAGE:-ghcr.io/radarsu/intentic/sandbox:0.1.0}"
PREVIEW_PORT="${PREVIEW_PORT:-8088}"
# Infra secrets the platform's Provision action needs `intentic apply` to read INSIDE the sandbox. Optional —
# set them in your shell when running this (e.g. HOST_SSH_KEY="$(cat ~/.ssh/key)" CLOUDFLARE_API_TOKEN=… …).
# They ride straight into the sandbox container's env; they are never sent to the platform.
HOST_SSH_KEY="${HOST_SSH_KEY:-}"
CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN:-}"
# Self-host: wire this machine as a deploy target. Off unless SELF_HOST is set (the platform one-liner sets it).
SELF_HOST="${SELF_HOST:-}"
SELF_HOST_USER="${SELF_HOST_USER:-}"

CONTAINER="intentic-runner"
NETWORK="intentic-workspace"

# Wire THIS machine as a deployable host: a dedicated service user in the docker group with a generated SSH key
# the sandbox uses to reach the host back over host.docker.internal. Idempotent — an existing user/key is reused
# so re-runs don't churn the key the platform pins. Needs root (uses `sudo -n` when not already root). Sets
# HOST_SSH_KEY (the generated private key) and SELF_HOST_USER for the runner to forward into the sandbox.
setup_self_host() {
    user="${SELF_HOST_USER:-intentic}"
    SELF_HOST_USER="$user"

    if [ "$(id -u)" = 0 ]; then
        SUDO=""
    elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
        SUDO="sudo -n"
    else
        echo "error: SELF_HOST setup needs root to create the '$user' user and authorize a key — re-run as root (sudo -i) or enable passwordless sudo." >&2
        exit 1
    fi
    if ! command -v useradd >/dev/null 2>&1; then
        echo "error: useradd not found — intentic self-host expects a standard Linux server (Debian/Ubuntu/RHEL)." >&2
        exit 1
    fi
    if ! command -v sshd >/dev/null 2>&1 && [ ! -x /usr/sbin/sshd ]; then
        echo "intentic: warning — no SSH server found; the sandbox can't deploy to this host until sshd is running." >&2
    fi

    if ! id "$user" >/dev/null 2>&1; then
        echo "intentic: creating service user '$user'…"
        $SUDO useradd -m -s /bin/bash "$user"
    fi
    # The host provider runs `docker version` over SSH, so the user needs docker access; group membership
    # applies to the sandbox's fresh SSH sessions. A missing docker group is a soft warning, not fatal.
    $SUDO usermod -aG docker "$user" 2>/dev/null || echo "intentic: warning — could not add '$user' to the docker group." >&2

    home="$(getent passwd "$user" | cut -d: -f6)"
    [ -n "$home" ] || home="/home/$user"
    ssh_dir="$home/.ssh"
    key="$ssh_dir/intentic_ed25519"
    auth="$ssh_dir/authorized_keys"
    $SUDO mkdir -p "$ssh_dir"
    # Generate once; reuse on re-runs so HOST_SSH_KEY (and the platform-pinned host key) stay stable.
    if ! $SUDO test -f "$key"; then
        echo "intentic: generating SSH key for '$user'…"
        $SUDO ssh-keygen -t ed25519 -N "" -C intentic-self-host -f "$key" >/dev/null
    fi
    # Authorize the public key for the service user (idempotent).
    pub="$($SUDO cat "$key.pub")"
    if ! $SUDO grep -qF "$pub" "$auth" 2>/dev/null; then
        echo "$pub" | $SUDO tee -a "$auth" >/dev/null
    fi
    $SUDO chown -R "$user:$user" "$ssh_dir"
    $SUDO chmod 700 "$ssh_dir"
    $SUDO chmod 600 "$auth" "$key"

    # The sandbox reads HOST_SSH_KEY to authenticate as '$user' on host.docker.internal; ride it into the container.
    HOST_SSH_KEY="$($SUDO cat "$key")"
    echo "intentic: this server is registered as a deploy target (user '$user')."
}

# Pull a published image. intentic's runner/sandbox images are PUBLIC, so no login is needed. But if this host
# has a stale/expired `docker login ghcr.io` (commonly left by Docker Desktop's credential store), docker
# presents that token instead of pulling anonymously and GHCR rejects the pull with "denied". On any pull
# failure, clear the ghcr.io login and retry once so the pull falls back to anonymous.
pull_image() {
    image="$1"
    if docker pull "$image"; then
        return 0
    fi
    echo "intentic: pull failed — clearing a stale ghcr.io login and retrying anonymously…" >&2
    docker logout ghcr.io >/dev/null 2>&1 || true
    docker pull "$image"
}

echo "intentic: checking Docker…"
if ! command -v docker >/dev/null 2>&1; then
    echo "error: docker is not installed. Install Docker Engine (Linux) or Docker Desktop, then re-run." >&2
    exit 1
fi
# `docker info` aggregates CLI-plugin data and can hang (e.g. docker-scout/buildx); `docker version`
# with a server-format does a fast daemon round-trip and fails cleanly if the daemon is unreachable.
if ! docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
    echo "error: the docker daemon is not running or not reachable. Start Docker, then re-run." >&2
    exit 1
fi
if [ -z "$PLATFORM_URL" ] || [ -z "$RUNNER_TOKEN" ]; then
    echo "error: PLATFORM_URL and RUNNER_TOKEN are required (env or positional args)." >&2
    exit 1
fi

# When requested, wire this machine as a deploy target before starting the runner — sets HOST_SSH_KEY (the
# generated key) and SELF_HOST_USER, which the runner forwards into the sandbox.
if [ -n "$SELF_HOST" ]; then
    setup_self_host
fi

# Pull explicitly (with visible progress) so a slow first-time pull doesn't look like a hang — and so a
# private/missing image surfaces as a clear error instead of silence.
echo "intentic: pulling runner image ${RUNNER_IMAGE} (first run can take a minute)…"
pull_image "$RUNNER_IMAGE"

echo "intentic: starting runner…"
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
    -e HOST_SSH_KEY="$HOST_SSH_KEY" \
    -e CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" \
    -e SELF_HOST_USER="$SELF_HOST_USER" \
    "$RUNNER_IMAGE" >/dev/null

echo "intentic runner started and dialing ${PLATFORM_URL}."
echo "Return to the platform — setup will continue automatically once it connects."
echo "Logs: docker logs -f ${CONTAINER}   Stop: docker rm -f ${CONTAINER}"
