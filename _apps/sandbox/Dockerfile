# The per-project AI-agent sandbox image (published as ghcr.io/radarsu/intentic/sandbox). Build from the REPO
# ROOT so the monorepo workspace resolves:
#   docker build -f _apps/sandbox/Dockerfile -t ghcr.io/radarsu/intentic/sandbox .
# At run time the runner injects agent credentials (ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN) and mounts
# the workspace (the three cloned repos) at /work — neither is baked into the image.

FROM node:24-bookworm AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
# turbo builds each package after its workspace deps (^build), so the CLI's libs are built before it.
RUN pnpm build
# Prune each package to a standalone, production-only tree (workspace deps bundled into node_modules).
RUN pnpm --filter @intentic/sandbox deploy --prod /out/sandbox
RUN pnpm --filter @intentic/cli deploy --prod /out/cli

FROM node:24-bookworm-slim AS runtime
# Links the GHCR package to the repo (inherits its visibility/permissions, shows under its Packages).
LABEL org.opencontainers.image.source=https://github.com/radarsu/intentic
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# The intentic CLI on PATH — the /intentic endpoint shells out to it for resolve/plan dry-runs.
COPY --from=build /out/cli /opt/intentic-cli
RUN ln -s /opt/intentic-cli/dist/cli.js /usr/local/bin/intentic
# The sandbox daemon.
COPY --from=build /out/sandbox /opt/sandbox
WORKDIR /work
ENV WORKSPACE_ROOT=/work SANDBOX_PORT=8787
EXPOSE 8787
ENTRYPOINT ["node", "/opt/sandbox/dist/main.js"]
