#!/bin/sh
# intentic cleanup — remove the sandbox's Docker footprint on THIS machine, INCLUDING the named workspace volume.
#
# Why this exists: the sandbox's /work is a NAMED Docker volume (intentic-workspace-workspace). `docker rm -v`
# and lazydocker's "remove with volumes" only prune ANONYMOUS volumes — a named volume survives every container
# remove, so a stale /work persists across re-runs and the daemon's boot gate then skips re-scaffolding. This
# removes the containers AND the named volumes AND the shared network, by EXACT name, so re-running connect starts
# from a clean slate. It deliberately leaves the platform's own resources (intentic-app-*) untouched.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/radarsu/intentic/main/scripts/cleanup.sh | sh
#   ./scripts/cleanup.sh
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

echo "intentic: removing sandbox containers…"
for c in intentic-sandbox-workspace intentic-sandbox-tunnel intentic-dind-host; do
    docker rm -f "$c" >/dev/null 2>&1 || true
done

# The step `docker rm -v` skips: named volumes must be removed explicitly. This is the persistent /work.
echo "intentic: removing named volumes (the persistent /work)…"
for v in intentic-workspace-workspace intentic-dind-docker; do
    docker volume rm "$v" >/dev/null 2>&1 || true
done

echo "intentic: removing the sandbox network…"
docker network rm intentic-workspace >/dev/null 2>&1 || true

echo "intentic: sandbox Docker state removed (containers + named volumes + network). Re-run connect to start fresh."
