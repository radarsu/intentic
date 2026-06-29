# The tenant-side runner image (published as ghcr.io/radarsu/intentic/runner). Build from the REPO ROOT so the
# monorepo workspace resolves:
#   docker build -f _apps/runner/Dockerfile -t ghcr.io/radarsu/intentic/runner .
# At run time the 2b provider bind-mounts the host docker socket and attaches this to the shared
# `intentic-workspace` network; the runner shells out to `docker` to manage per-project sandboxes.

FROM node:24.18.0-bookworm@sha256:fdddfb3e688158251943d52eba361de991548f6814007acba4917ae6b512d6be AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build
RUN pnpm --filter @intentic/runner deploy --prod /out/runner

FROM node:24.18.0-bookworm-slim@sha256:b31e7a42fdf8b8aa5f5ed477c72d694301273f1069c5a2f71d53c6482e99a2fc AS runtime
# Links the GHCR package to the repo (inherits its visibility/permissions, shows under its Packages).
LABEL org.opencontainers.image.source=https://github.com/radarsu/intentic
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# The docker CLI (static) from the official image — the runner drives the host daemon over the mounted socket.
COPY --from=docker:28.5.2-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=build /out/runner /opt/runner
ENV PREVIEW_PORT=8088
EXPOSE 8088
ENTRYPOINT ["node", "/opt/runner/dist/main.js"]
