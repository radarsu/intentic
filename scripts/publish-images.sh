#!/usr/bin/env bash
# Build + push the first-party intentic images (the AI-agent workspace runner + its sandbox) to the repo's
# GHCR (ghcr.io/radarsu/intentic/{runner,sandbox}). Used by CI — the Images workflow (latest + commit SHA on
# push to main) and the release (the version, via semantic-release successCmd) — and runnable by hand:
#   docker login ghcr.io && TAGS=0.1.0 pnpm publish:images
# TAGS is a space-separated tag list; every listed tag is pushed for both images. The release version's digest
# is pinned into _libs/state-resolver/src/images.ts (Renovate maintains it). The GHCR packages must be made
# public once so tenant hosts can pull them unauthenticated.
set -euo pipefail

TAGS="${TAGS:?set TAGS (space-separated, e.g. "0.1.0" or "latest sha-abc1234")}"
REGISTRY="ghcr.io/radarsu/intentic"
root="$(cd "$(dirname "$0")/.." && pwd)"

for app in runner sandbox; do
    tag_args=()
    for tag in $TAGS; do
        tag_args+=(-t "$REGISTRY/$app:$tag")
    done
    docker buildx build \
        -f "$root/_apps/$app/Dockerfile" \
        "${tag_args[@]}" \
        --push \
        "$root"
done
