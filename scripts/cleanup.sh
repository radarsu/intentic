#!/bin/sh
# intentic cleanup — remove intentic sandboxes' Docker footprint on THIS machine, INCLUDING the named /work volumes.
#
# Why this exists: a sandbox's /work is a NAMED Docker volume (intentic-workspace-<slug>). `docker rm -v` and
# lazydocker's "remove with volumes" only prune ANONYMOUS volumes — a named volume survives every container remove,
# so a stale /work persists across re-runs and the daemon's boot gate then skips re-scaffolding. This removes the
# containers AND the named volumes AND the networks. With a <slug> arg it removes just that one sandbox; with no arg
# it removes EVERY intentic sandbox, matched by name prefix. It deliberately leaves the platform's own resources
# (intentic-app-*) untouched.
#
# Usage:
#   curl -fsSL https://intentic.dev/cleanup | sh            # all sandboxes
#   curl -fsSL https://intentic.dev/cleanup | sh -s -- SLUG # one sandbox
#   ./scripts/cleanup.sh [SLUG]
#
# NOT removed (host-level, only exist after a SELF_HOST=1 run; recreated on the next one): the
# `intentic-host-ssh-tunnel` systemd unit, the natively-installed cloudflared, and the `intentic` service user.
# Remove them by hand if you want a full teardown:
#   sudo systemctl disable --now intentic-host-ssh-tunnel.service; sudo rm -f /etc/systemd/system/intentic-host-ssh-tunnel.service
#   sudo userdel -r intentic
# POSIX sh (this is piped into `sh`, which is dash on Debian/Ubuntu/WSL).
set -eu

if ! command -v docker >/dev/null 2>&1; then
    echo "error: docker is not installed — nothing to clean up." >&2
    exit 1
fi

# A single sandbox slug (as printed by connect.sh's reset hint) targets just that instance; no arg matches every
# intentic sandbox by name prefix. Prefixes never overlap the platform's intentic-app-* resources. The sidecar
# container (intentic-sandbox-tunnel-<slug>) shares the intentic-sandbox- prefix, so the prefix pass catches it too.
slug="${1:-}"
if [ -n "$slug" ]; then
    containers="intentic-sandbox-$slug intentic-sandbox-tunnel-$slug intentic-dind-host-$slug"
    volumes="intentic-workspace-$slug intentic-history-$slug intentic-dind-docker-$slug"
    networks="intentic-workspace-$slug"
else
    containers="$(docker ps -aq --filter 'name=intentic-sandbox-'; docker ps -aq --filter 'name=intentic-dind-host-')"
    volumes="$(docker volume ls -q --filter 'name=intentic-workspace-'; docker volume ls -q --filter 'name=intentic-history-'; docker volume ls -q --filter 'name=intentic-dind-docker-')"
    networks="$(docker network ls -q --filter 'name=intentic-workspace-')"
fi

echo "intentic: removing sandbox containers…"
for c in $containers; do
    docker rm -f "$c" >/dev/null 2>&1 || true
done

# `docker rm -v` prunes only ANONYMOUS volumes; the named /work volume must be removed explicitly.
echo "intentic: removing named volumes (the persistent /work)…"
for v in $volumes; do
    docker volume rm "$v" >/dev/null 2>&1 || true
done

echo "intentic: removing sandbox network(s)…"
for n in $networks; do
    docker network rm "$n" >/dev/null 2>&1 || true
done

echo "intentic: sandbox Docker state removed (containers + named volumes + network). Re-run connect to start fresh."
