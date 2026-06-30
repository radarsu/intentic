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
# Usage (the platform's setup screen hands you a copy-paste one-liner):
#   curl -fsSL https://raw.githubusercontent.com/radarsu/intentic/main/scripts/connect.sh | sudo env CF_TOKEN=… CONNECT_TOKEN=… sh
#   ./connect.sh <PLATFORM_URL> <CONNECT_TOKEN>   (positional; PLATFORM_URL defaults to the central platform)
#
# Required — only the two values the platform can't bake in:
#   CF_TOKEN       your Cloudflare API token (Zone:Read, DNS:Edit, Tunnel:Edit) — intentic's reachability fabric; passed to the sandbox as CLOUDFLARE_API_TOKEN
#   CONNECT_TOKEN  the per-user connection token the platform mints + fills into the one-liner
#
# Platform statics (defaulted below — overridden only for local dev against a non-prod platform):
#   PLATFORM_URL         the platform base the sandbox registers back to (default: https://platform.intentic.dev)
#   GOOGLE_CLIENT_ID     the platform's PUBLIC Google web client id the daemon verifies sign-in against (default: hardcoded below)
#
# Optional env:
#   SANDBOX_IMAGE   sandbox image to run (default: the pinned release ghcr.io/radarsu/intentic/sandbox:1.32.0)
#   DEV_COMMAND     the app's dev/watch command inside the sandbox (default: pnpm dev)
#   DEV_PORT        the app's dev-server port, exposed at *.preview.<zone> (default: 5173)
#   WEB_ORIGIN      scopes the daemon's CORS to the platform web app (default: open — the Google-token audience is the real gate)
#   ZONE            the Cloudflare zone to use when the token sees more than one
#   SELF_HOST       wire THIS machine as a deploy target (service user + SSH key). DEFAULT ON — the platform flow
#                   always self-hosts (needs root, hence `sudo`). Opt out of a non-deploy run with `SELF_HOST= `.
#   SELF_HOST_USER  the service user to create/use for self-host (default: intentic).
# POSIX sh (this is piped into `sh`, which is dash on Debian/Ubuntu/WSL — no `pipefail`).
set -eu

# The central platform is a single static domain (never self-hosted), so PLATFORM_URL defaults to it. The sandbox
# registers its public URL at ${PLATFORM_URL}/sandbox/register. LOCAL DEV ONLY: to test against a platform running
# on your own machine, prepend PLATFORM_URL=http://host.docker.internal:<apiPort> (the sandbox container reaches
# your host's platform there, not localhost) — this is never shown in the product UI.
PLATFORM_URL="${PLATFORM_URL:-${1:-https://platform.intentic.dev}}"
CONNECT_TOKEN="${CONNECT_TOKEN:-${2:-}}"
# A version-pinned RELEASE image, never :latest: the release pipeline bumps every @intentic/* package to the
# release version, publishes them to npm, THEN builds this image — so its bundled CLI is that version and the
# intent repo `intentic init` scaffolds (~<version>) resolves from npm. The continuous :latest / hand-tagged
# builds carry internal version 0.0.0 (unpublished), so init's `pnpm install` fails and resolve can't find
# @intentic/graph. Renovate bumps the tag+digest on each release (see renovate.json5).
# renovate: datasource=docker depName=ghcr.io/radarsu/intentic/sandbox
SANDBOX_IMAGE="${SANDBOX_IMAGE:-ghcr.io/radarsu/intentic/sandbox:1.32.0@sha256:434dda985897f3efd8246b045dbd6cc9af1c679ee7faf55e1f4c51db303df7c8}"
# The app's dev/watch command + port the sandbox daemon runs; the port is exposed at *.preview.<zone>.
DEV_COMMAND="${DEV_COMMAND:-pnpm dev}"
DEV_PORT="${DEV_PORT:-5173}"
# Infra secrets `intentic apply` reads INSIDE the sandbox; they ride straight into the sandbox container's env
# and are never sent to the platform. CF_TOKEN (your Cloudflare API token) is REQUIRED — Cloudflare is intentic's
# reachability fabric (the tunnel that connects your services, exposes them, AND carries the browser→sandbox
# traffic); it is validated below and passed to the sandbox as the Cloudflare-standard CLOUDFLARE_API_TOKEN the
# CLI reads. HOST_SSH_KEY is optional (auto-generated when SELF_HOST wires this machine as a deploy target).
HOST_SSH_KEY="${HOST_SSH_KEY:-}"
CF_TOKEN="${CF_TOKEN:-}"
# Self-host: wire this machine as a deploy target. DEFAULT ON — the platform flow always makes this machine the
# first deploy target (the one-liner runs under `sudo`). Opt out of a non-deploy run with `SELF_HOST= ` (empty).
SELF_HOST="${SELF_HOST-1}"
SELF_HOST_USER="${SELF_HOST_USER:-}"
# Browser-direct access: the sandbox is exposed at sandbox-<id>.<zone> via its OWN Cloudflare tunnel and the
# browser talks to it directly — the daemon verifies the user's Google ID token (audience = GOOGLE_CLIENT_ID, the
# platform's PUBLIC web client id, hardcoded here since it's a static platform value) and binds the owner on first
# connect (gated by CONNECT_TOKEN). WEB_ORIGIN, when set, scopes the daemon's CORS to the platform web app; left
# empty the daemon allows any origin (the Google-token audience is the real gate). ZONE picks the zone when the
# token sees several.
GOOGLE_CLIENT_ID="${GOOGLE_CLIENT_ID:-481795963975-cq9msl6higcd91joidrfp8mjlkuq5fk3.apps.googleusercontent.com}"
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
    echo "error: the docker daemon is not running or not reachable. Start Docker, then re-run." >&2
    exit 1
fi
# CONNECT_TOKEN is the only per-user value the one-liner carries — the platform mints it and fills it in.
# PLATFORM_URL + GOOGLE_CLIENT_ID default to the platform's static values above, so only this must be present.
if [ -z "$CONNECT_TOKEN" ]; then
    echo "error: CONNECT_TOKEN is required (env or positional arg) — copy the one-liner from the platform's setup screen." >&2
    exit 1
fi

# Cloudflare is intentic's reachability fabric (the tunnel that connects services and exposes them), so the
# token is required and validated up front rather than failing later at `intentic apply`. The token never
# reaches the platform — it rides into the sandbox below. Verify it against Cloudflare's token-verify endpoint
# (the same Bearer/api.cloudflare.com auth intentic itself uses). `*: *true` tolerates compact or spaced JSON.
if [ -z "$CF_TOKEN" ]; then
    echo "error: CF_TOKEN is required — Cloudflare is intentic's reachability fabric (the tunnel that" >&2
    echo "       connects your services and exposes them). Create a token at" >&2
    echo "       https://dash.cloudflare.com/profile/api-tokens with: Zone:Read, DNS:Edit, Cloudflare Tunnel:Edit." >&2
    exit 1
fi
echo "intentic: validating Cloudflare API token…"
cf_verify="$(curl -sS -H "Authorization: Bearer $CF_TOKEN" https://api.cloudflare.com/client/v4/user/tokens/verify 2>/dev/null || true)"
if ! printf '%s' "$cf_verify" | grep -q '"success": *true' || ! printf '%s' "$cf_verify" | grep -q '"status": *"active"'; then
    echo "error: the Cloudflare API token is invalid or inactive (token verify failed). Re-check the token and its" >&2
    echo "       scopes (Zone:Read, DNS:Edit, Cloudflare Tunnel:Edit) at https://dash.cloudflare.com/profile/api-tokens." >&2
    exit 1
fi

# Resolve the Cloudflare zone the sandbox tunnel lives under BEFORE the tunnel step, so a token that sees several
# zones gets a clear choice here instead of a bare "multiple zones" crash deep inside the CLI. The platform's
# setup screen normally pins ZONE already; this covers direct/CI runs (and any path that didn't set it). List the
# token's zones (same Bearer auth as the verify above) and parse "name":"…" with grep/sed — no jq on a stock box.
if [ -z "$ZONE" ]; then
    echo "intentic: resolving the Cloudflare zone…"
    zones_json="$(curl -sS -H "Authorization: Bearer $CF_TOKEN" "https://api.cloudflare.com/client/v4/zones?per_page=50" 2>/dev/null || true)"
    zones="$(printf '%s' "$zones_json" | grep -o '"name":"[^"]*"' | sed 's/^"name":"//;s/"$//' || true)"
    zone_count="$(printf '%s\n' "$zones" | grep -c . || true)"
    if [ "$zone_count" -eq 0 ]; then
        echo "error: the Cloudflare API token sees no zones — add a domain to the account, or broaden the token's" >&2
        echo "       Zone:Read scope, at https://dash.cloudflare.com/profile/api-tokens, then re-run." >&2
        exit 1
    elif [ "$zone_count" -eq 1 ]; then
        ZONE="$zones"
        echo "intentic: using the only zone the token sees — $ZONE."
    elif [ -r /dev/tty ]; then
        # The human is at a terminal even under `curl … | sh` (stdin is the script), so prompt on /dev/tty.
        echo "intentic: this Cloudflare token can use several zones — pick the one your sandbox should use:" >&2
        i=1
        for z in $zones; do
            echo "  $i) $z" >&2
            i=$((i + 1))
        done
        printf "intentic: zone number [1]: " >&2
        read -r choice </dev/tty || choice=1
        [ -n "$choice" ] || choice=1
        case "$choice" in
            *[!0-9]*)
                echo "error: invalid selection '$choice'." >&2
                exit 1
                ;;
        esac
        ZONE="$(printf '%s\n' "$zones" | sed -n "${choice}p")"
        if [ -z "$ZONE" ]; then
            echo "error: '$choice' is out of range." >&2
            exit 1
        fi
        echo "intentic: using zone $ZONE."
    else
        # Non-interactive (no controlling terminal): can't prompt, so name the zones and the exact remedy.
        first="$(printf '%s\n' "$zones" | sed -n '1p')"
        echo "error: the Cloudflare API token sees multiple zones; set ZONE to choose one. The token can use:" >&2
        for z in $zones; do
            echo "  - $z" >&2
        done
        echo "       Re-run with ZONE set in the environment (alongside CF_TOKEN), e.g. ZONE=$first" >&2
        exit 1
    fi
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
    -e CLOUDFLARE_API_TOKEN="$CF_TOKEN" \
    -e CONNECT_TOKEN="$CONNECT_TOKEN" \
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
    -e CONNECT_TOKEN="$CONNECT_TOKEN" \
    -e WEB_ORIGIN="$WEB_ORIGIN" \
    -e SANDBOX_PUBLIC_URL="$SANDBOX_PUBLIC_URL" \
    -e PLATFORM_URL="$PLATFORM_URL" \
    -e CLOUDFLARE_API_TOKEN="$CF_TOKEN" \
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
