# The per-project AI-agent sandbox image (published as ghcr.io/radarsu/intentic/sandbox). Build from the REPO
# ROOT so the monorepo workspace resolves:
#   docker build -f _apps/sandbox/Dockerfile -t ghcr.io/radarsu/intentic/sandbox .
# At run time connect.sh / the workspace provider inject agent credentials (ANTHROPIC_API_KEY or
# CLAUDE_CODE_OAUTH_TOKEN) and mount the workspace volume at /work — neither is baked into the image.

FROM node:24.18.0-bookworm@sha256:fdddfb3e688158251943d52eba361de991548f6814007acba4917ae6b512d6be AS build
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

FROM node:24.18.0-bookworm-slim@sha256:b31e7a42fdf8b8aa5f5ed477c72d694301273f1069c5a2f71d53c6482e99a2fc AS runtime
# Links the GHCR package to the repo (inherits its visibility/permissions, shows under its Packages).
LABEL org.opencontainers.image.source=https://github.com/radarsu/intentic
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# The daemon runs the app's `pnpm dev` (dev-server.ts) — the build stage's corepack doesn't carry over, so
# enable it here too and bake in the repo's pinned pnpm so the sandbox needs no first-run download or prompt.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
# The intentic CLI on PATH — the /intentic endpoint shells out to it for resolve/plan dry-runs, and
# connect.sh runs it via `--entrypoint intentic`. tsc emits cli.js without the exec bit, so chmod it:
# runc resolves the entrypoint with Go's exec.LookPath, which reports a non-executable PATH entry as
# "executable file not found in $PATH".
COPY --from=build /out/cli /opt/intentic-cli
RUN chmod +x /opt/intentic-cli/dist/cli.js \
    && ln -s /opt/intentic-cli/dist/cli.js /usr/local/bin/intentic
# The sandbox daemon.
COPY --from=build /out/sandbox /opt/sandbox
WORKDIR /work
ENV WORKSPACE_ROOT=/work SANDBOX_PORT=8787
EXPOSE 8787
ENTRYPOINT ["node", "/opt/sandbox/dist/main.js"]
