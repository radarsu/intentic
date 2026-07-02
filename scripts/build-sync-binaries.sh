#!/bin/sh
# Cross-compile the intentic-sync agent into standalone binaries (release assets for scripts/sync.sh).
# Runs after `pnpm turbo run build`; expects _apps/sync/dist/cli.js to exist and `bun` on PATH.
set -eu
cd "$(dirname "$0")/.."

out="_apps/sync/dist-bin"
mkdir -p "$out"
for target in linux-x64 linux-arm64 darwin-x64 darwin-arm64; do
    os="${target%-*}"
    arch="${target#*-}"
    # Asset names use go-style arch (amd64) to match what sync.sh requests.
    [ "$arch" = "x64" ] && arch=amd64
    bun build --compile --target="bun-${target}" _apps/sync/dist/cli.js --outfile "${out}/intentic-sync-${os}-${arch}"
done
