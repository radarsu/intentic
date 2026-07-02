#!/bin/sh
# intentic desktop sync — install the sync agent on THIS machine and two-way sync a local folder with your
# sandbox's /work (block-delta, near-real-time, powered by Mutagen). Runs as YOU (no sudo): it installs into
# ~/.intentic/sync and registers a per-user login agent.
#
# Usage (the platform's Desktop sync card hands you this):
#   curl -fsSL https://raw.githubusercontent.com/radarsu/intentic/main/scripts/sync.sh | env SANDBOX_URL='https://sandbox-<id>.<zone>' SYNC_DIR="$HOME/intentic/<name>" sh
#
# Required env:
#   SANDBOX_URL  your sandbox's public URL (from the card). NOT secret — auth is your Google sign-in.
# Optional env:
#   SYNC_DIR     local folder to sync (default: ~/intentic/<sandbox-host>)
set -eu

URL="${SANDBOX_URL:-}"
DIR="${SYNC_DIR:-}"
if [ -z "$URL" ]; then
    echo "error: SANDBOX_URL is required (copy the command from the Desktop sync card)." >&2
    exit 1
fi

os="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$os" in
    linux | darwin) ;;
    *)
        echo "error: unsupported OS '$os' — see the docs for manual setup." >&2
        exit 1
        ;;
esac
arch="$(uname -m)"
case "$arch" in
    x86_64 | amd64) arch="amd64" ;;
    arm64 | aarch64) arch="arm64" ;;
    *)
        echo "error: unsupported CPU arch '$arch'." >&2
        exit 1
        ;;
esac

# Resolve the agent: an installed `intentic-sync`, else the released binary, else npx (when Node is present).
BIN="$(command -v intentic-sync || true)"
if [ -z "$BIN" ]; then
    dest="${HOME}/.intentic/sync/bin/intentic-sync"
    mkdir -p "$(dirname "$dest")"
    echo "Downloading the intentic-sync agent…"
    if curl -fsSL "https://github.com/radarsu/intentic/releases/latest/download/intentic-sync-${os}-${arch}" -o "$dest" 2>/dev/null; then
        chmod +x "$dest"
        BIN="$dest"
    elif command -v npx >/dev/null 2>&1; then
        BIN="npx -y @intentic/sync@stable"
    else
        echo "error: could not download the agent and no npx fallback (install Node.js, or see the docs)." >&2
        exit 1
    fi
fi

set -- setup --url "$URL"
[ -n "$DIR" ] && set -- "$@" --dir "$DIR"
# BIN may be "npx -y @intentic/sync@stable" (intentional word-split); a real path runs directly.
# shellcheck disable=SC2086
exec $BIN "$@"
