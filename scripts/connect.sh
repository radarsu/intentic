#!/bin/sh
# intentic connect — run the AI-agent workspace sandbox on THIS machine and expose it to your browser, so a
# user without their own server can drive a project from their PC.
#
# How: the platform mints a per-project connection token and hands you this one-liner. The script creates the
# sandbox's OWN Cloudflare tunnel (sandbox-<id>.<zone> → the daemon, plus *.preview.<zone> → the app preview),
# starts the published sandbox image as a long-lived, UNPRIVILEGED container (no Docker socket), and runs a
# cloudflared sidecar. The browser then talks to the sandbox DIRECTLY over that tunnel — the daemon verifies
# your Google sign-in, and the platform stays off the command path (it never reaches into your machine). On
# boot the sandbox registers its public URL with the platform's directory, so its setup gate flips to "ready".
#
# Usage (env or positional args):
#   PLATFORM_URL=https://platform.example RUNNER_TOKEN=<token> ./connect.sh
#   ./connect.sh <PLATFORM_URL> <RUNNER_TOKEN>
#   curl -fsSL https://raw.githubusercontent.com/radarsu/intentic/main/scripts/connect.sh | PLATFORM_URL=… RUNNER_TOKEN=… sh
#
# Required (env or positional — the platform's setup screen fills these into the one-liner):
#   PLATFORM_URL         the platform base the sandbox registers back to, e.g. https://platform.example
#   RUNNER_TOKEN         the per-project connection token the platform's setup screen shows you
#   CLOUDFLARE_API_TOKEN a Cloudflare token (Zone:Read, DNS:Edit, Tunnel:Edit) — intentic's reachability fabric
#   GOOGLE_CLIENT_ID     the platform's PUBLIC Google web client id; the daemon verifies your browser sign-in against it
#
# Optional env:
#   SANDBOX_IMAGE   sandbox image to run (default: ghcr.io/radarsu/intentic/sandbox:0.1.0)
#   DEV_COMMAND     the app's dev/watch command inside the sandbox (default: pnpm dev)
#   DEV_PORT        the app's dev-server port, exposed at *.preview.<zone> (default: 5173)
#   WEB_ORIGIN      the platform web app's origin; scopes the daemon's CORS (set by the one-liner)
#   ZONE            the Cloudflare zone to use when the token sees more than one
#   SELF_HOST       when set (the platform's curl one-liner sets SELF_HOST=1), wire THIS machine as a deploy
#                   target: a dedicated service user in the docker group + a generated SSH key the sandbox uses
#                   to reach the host back at host.docker.internal. Needs root (server, Linux only).
#   SELF_HOST_USER  the service user to create/use for self-host (default: intentic).
# POSIX sh (this is piped into `sh`, which is dash on Debian/Ubuntu/WSL — no `pipefail`).
set -eu

PLATFORM_URL="${PLATFORM_URL:-${1:-}}"
RUNNER_TOKEN="${RUNNER_TOKEN:-${2:-}}"
SANDBOX_IMAGE="${SANDBOX_IMAGE:-ghcr.io/radarsu/intentic/sandbox:0.1.0}"
# The app's dev/watch command + port the sandbox daemon runs; the port is exposed at *.preview.<zone>.
DEV_COMMAND="${DEV_COMMAND:-pnpm dev}"
DEV_PORT="${DEV_PORT:-5173}"
# Infra secrets `intentic apply` reads INSIDE the sandbox; they ride straight into the sandbox container's env
# and are never sent to the platform. CLOUDFLARE_API_TOKEN is REQUIRED — Cloudflare is intentic's reachability
# fabric (the tunnel that connects your services, exposes them, AND carries the browser→sandbox traffic); it is
# validated below before the sandbox starts. HOST_SSH_KEY is optional (auto-generated when SELF_HOST wires this
# machine as a deploy target).
HOST_SSH_KEY="${HOST_SSH_KEY:-}"
CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN:-}"
# Self-host: wire this machine as a deploy target. Off unless SELF_HOST is set (the platform one-liner sets it).
SELF_HOST="${SELF_HOST:-}"
SELF_HOST_USER="${SELF_HOST_USER:-}"
# Browser-direct access: the sandbox is exposed at sandbox-<id>.<zone> via its OWN Cloudflare tunnel and the
# browser talks to it directly — the daemon verifies the user's Google ID token (audience = GOOGLE_CLIENT_ID,
# the platform's public web client id) and binds the owner on first connect (gated by RUNNER_TOKEN). WEB_ORIGIN
# scopes the daemon's CORS to the platform web app; ZONE picks the Cloudflare zone when the token sees several.
GOOGLE_CLIENT_ID="${GOOGLE_CLIENT_ID:-}"
WEB_ORIGIN="${WEB_ORIGIN:-}"
ZONE="${ZONE:-}"
CLOUDFLARED_IMAGE="${CLOUDFLARED_IMAGE:-cloudflare/cloudflared:2026.6.1}"
TUNNEL_TOKEN=""
SANDBOX_PUBLIC_URL=""

# One sandbox per machine; the name is fixed so the tunnel ingress + cloudflared sidecar resolve it by DNS on
# the shared network, and the workspace volume persists the cloned repos across re-runs.
CONTAINER="intentic-sandbox-workspace"
WORKSPACE_VOLUME="intentic-workspace-workspace"
NETWORK="intentic-workspace"

# Wire THIS machine as a deployable host: a dedicated service user in the docker group with a generated SSH key
# the sandbox uses to reach the host back over host.docker.internal. Idempotent — an existing user/key is reused
# so re-runs don't churn the key the platform pins. Needs root (uses `sudo -n` when not already root). Sets
# HOST_SSH_KEY (the generated private key) and SELF_HOST_USER, which ride into the sandbox container's env.
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

# Pull a published image. intentic's sandbox image is PUBLIC, so no login is needed. But if this host
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
    echo "error: can't reach the docker daemon. Start Docker — and if it is running, your user may lack" >&2
    echo "       access: add it to the 'docker' group (then re-login or 'newgrp docker'), or re-run with sudo." >&2
    exit 1
fi
if [ -z "$PLATFORM_URL" ] || [ -z "$RUNNER_TOKEN" ]; then
    echo "error: PLATFORM_URL and RUNNER_TOKEN are required (env or positional args)." >&2
    exit 1
fi
# The browser reaches the sandbox over a PUBLIC tunnel, so the daemon must authenticate every request: it
# verifies the caller's Google ID token against GOOGLE_CLIENT_ID. Without it the daemon would be open to the
# internet — refuse to start. The platform's setup one-liner always fills this in.
if [ -z "$GOOGLE_CLIENT_ID" ]; then
    echo "error: GOOGLE_CLIENT_ID is required — it is the platform's public Google web client id the sandbox" >&2
    echo "       verifies your browser sign-in against. Use the one-liner from the platform's setup screen." >&2
    exit 1
fi

# Cloudflare is intentic's reachability fabric (the tunnel that connects services and exposes them), so the
# token is required and validated up front rather than failing later at `intentic apply`. The token never
# reaches the platform — it rides into the sandbox below. Verify it against Cloudflare's token-verify endpoint
# (the same Bearer/api.cloudflare.com auth intentic itself uses). `*: *true` tolerates compact or spaced JSON.
if [ -z "$CLOUDFLARE_API_TOKEN" ]; then
    echo "error: CLOUDFLARE_API_TOKEN is required — Cloudflare is intentic's reachability fabric (the tunnel that" >&2
    echo "       connects your services and exposes them). Create a token at" >&2
    echo "       https://dash.cloudflare.com/profile/api-tokens with: Zone:Read, DNS:Edit, Cloudflare Tunnel:Edit." >&2
    exit 1
fi
echo "intentic: validating Cloudflare API token…"
cf_verify="$(curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" https://api.cloudflare.com/client/v4/user/tokens/verify 2>/dev/null || true)"
if ! printf '%s' "$cf_verify" | grep -q '"success": *true' || ! printf '%s' "$cf_verify" | grep -q '"status": *"active"'; then
    echo "error: the Cloudflare API token is invalid or inactive (token verify failed). Re-check the token and its" >&2
    echo "       scopes (Zone:Read, DNS:Edit, Cloudflare Tunnel:Edit) at https://dash.cloudflare.com/profile/api-tokens." >&2
    exit 1
fi

# When requested, wire this machine as a deploy target before starting the sandbox — sets HOST_SSH_KEY (the
# generated key) and SELF_HOST_USER, which ride into the sandbox container's env below.
if [ -n "$SELF_HOST" ]; then
    setup_self_host
fi

# Pull the pinned image up front (with visible progress) so a slow first-time pull doesn't look like a
# hang, a private/missing image surfaces as a clear error — and the tunnel step below, which runs this
# same image via `--entrypoint intentic`, never executes a stale locally-cached tag (docker run reuses a
# cached tag without re-pulling, so a republished image would otherwise be missed).
echo "intentic: pulling sandbox image ${SANDBOX_IMAGE} (first run can take a minute)…"
pull_image "$SANDBOX_IMAGE"

# Create/refresh this sandbox's own Cloudflare tunnel + DNS so the browser can reach it directly:
# sandbox-<id>.<zone> → the daemon (:8787) and *.preview.<zone> → the app dev server (:$DEV_PORT). The sandbox
# image carries the intentic CLI, which makes the Cloudflare API calls (reusing the providers' client) and
# prints the connector token; cloudflared runs as a sidecar once the sandbox is up.
echo "intentic: creating the sandbox tunnel…"
zone_env=""
[ -n "$ZONE" ] && zone_env="-e ZONE=$ZONE"
# --entrypoint intentic: the image's default entrypoint is the daemon; we want the bundled CLI instead.
tunnel_out="$(docker run --rm --entrypoint intentic \
    -e CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" \
    -e CONNECT_TOKEN="$RUNNER_TOKEN" \
    $zone_env \
    "$SANDBOX_IMAGE" sandbox-tunnel \
    --service "http://${CONTAINER}:8787" \
    --preview-service "http://${CONTAINER}:${DEV_PORT}")"
TUNNEL_TOKEN="$(printf '%s\n' "$tunnel_out" | sed -n 's/^TUNNEL_TOKEN=//p')"
SANDBOX_HOSTNAME="$(printf '%s\n' "$tunnel_out" | sed -n 's/^SANDBOX_HOSTNAME=//p')"
if [ -z "$TUNNEL_TOKEN" ] || [ -z "$SANDBOX_HOSTNAME" ]; then
    echo "error: failed to create the sandbox tunnel (see the output above)." >&2
    exit 1
fi
SANDBOX_PUBLIC_URL="https://$SANDBOX_HOSTNAME"

echo "intentic: starting sandbox…"
# cloudflared (the sidecar below) reaches the sandbox by container name on this shared network; create it first.
docker network inspect "$NETWORK" >/dev/null 2>&1 || docker network create "$NETWORK" >/dev/null
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

# Runs UNPRIVILEGED: no --user root and no Docker-socket mount — the sandbox no longer manages other containers,
# it IS the workspace. --add-host lets the sandbox reach the host it runs on at host.docker.internal (SSH
# self-host deploys target it). The workspace volume persists the cloned repos across re-runs. The daemon binds
# 0.0.0.0:8787 on the private network; only the Cloudflare tunnel exposes it (no host port is published).
# GOOGLE_CLIENT_ID/CONNECT_TOKEN/WEB_ORIGIN activate the browser-facing auth; SANDBOX_PUBLIC_URL + PLATFORM_URL
# let the sandbox register its public URL back with the platform's directory; CLOUDFLARE_API_TOKEN/HOST_SSH_KEY/
# SELF_HOST_USER are the infra secrets the in-sandbox `intentic apply` reads (they never touch the platform).
docker run -d --restart unless-stopped --name "$CONTAINER" \
    --network "$NETWORK" \
    --add-host host.docker.internal:host-gateway \
    -v "${WORKSPACE_VOLUME}:/work" \
    -e WORKSPACE_ROOT="/work" \
    -e SANDBOX_HOST="0.0.0.0" \
    -e SANDBOX_PORT="8787" \
    -e SANDBOX_NAME="$CONTAINER" \
    -e SANDBOX_IMAGE="$SANDBOX_IMAGE" \
    -e DEV_COMMAND="$DEV_COMMAND" \
    -e DEV_PORT="$DEV_PORT" \
    -e GOOGLE_CLIENT_ID="$GOOGLE_CLIENT_ID" \
    -e CONNECT_TOKEN="$RUNNER_TOKEN" \
    -e WEB_ORIGIN="$WEB_ORIGIN" \
    -e SANDBOX_PUBLIC_URL="$SANDBOX_PUBLIC_URL" \
    -e PLATFORM_URL="$PLATFORM_URL" \
    -e CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" \
    -e HOST_SSH_KEY="$HOST_SSH_KEY" \
    -e SELF_HOST_USER="$SELF_HOST_USER" \
    "$SANDBOX_IMAGE" >/dev/null

# Start the tunnel connector: cloudflared on the shared network routes sandbox-<id>.<zone> → the daemon and
# *.preview.<zone> → the app preview. It retries until the sandbox is up, so ordering is not critical.
echo "intentic: starting the sandbox tunnel connector…"
docker rm -f intentic-sandbox-tunnel >/dev/null 2>&1 || true
docker run -d --restart unless-stopped --name intentic-sandbox-tunnel --network "$NETWORK" \
    "$CLOUDFLARED_IMAGE" tunnel --no-autoupdate run --token "$TUNNEL_TOKEN" >/dev/null

echo "intentic sandbox started and registering with ${PLATFORM_URL}."
echo "Your sandbox will be reachable at ${SANDBOX_PUBLIC_URL} (DNS may take a few seconds to propagate)."
echo "Return to the platform — setup will continue automatically once it connects."
echo "Logs: docker logs -f ${CONTAINER}   Stop: docker rm -f ${CONTAINER} intentic-sandbox-tunnel"
