# The per-project AI-agent sandbox image (published as ghcr.io/radarsu/intentic/sandbox). Build from the REPO
# ROOT so the monorepo workspace resolves:
#   docker build -f _apps/sandbox/Dockerfile -t ghcr.io/radarsu/intentic/sandbox .
# At run time connect.sh / the workspace provider inject agent credentials (ANTHROPIC_API_KEY or
# CLAUDE_CODE_OAUTH_TOKEN) and mount the workspace volume at /work — neither is baked into the image.

FROM node:24.18.0-bookworm@sha256:fdddfb3e688158251943d52eba361de991548f6814007acba4917ae6b512d6be AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
# Fetch the cloudflared binary (copied into the runtime image below) so the in-sandbox `intentic apply` can
# run `cloudflared access tcp` to reach a NAT'd self-host's SSH over its Cloudflare tunnel (via:"cloudflared").
# Pinned to the same version connect.sh runs as the tunnel sidecar.
ARG CLOUDFLARED_VERSION=2026.6.1
RUN arch="$(dpkg --print-architecture)" \
    && curl -fsSL "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-${arch}" -o /usr/local/bin/cloudflared \
    && chmod +x /usr/local/bin/cloudflared \
    && /usr/local/bin/cloudflared --version
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
# procps gives the interactive terminal (system/terminal.ts) real process tools — `ps`, `top`, `kill` — so the
# owner can see what's running in the sandbox and reap a stuck dev command. zsh is the terminal's shell (below).
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates procps zsh \
    && rm -rf /var/lib/apt/lists/*
# The terminal (system/terminal.ts) launches zsh with the oh-my-zsh "bira" theme + zsh-autosuggestions, so the
# owner gets a real prompt and history autocomplete. Installed into root's home (the daemon/terminal run as
# root); --depth=1 tracks the default branch (pin to a commit if reproducibility matters).
RUN git clone --depth=1 https://github.com/ohmyzsh/ohmyzsh.git /root/.oh-my-zsh \
    && git clone --depth=1 https://github.com/zsh-users/zsh-autosuggestions /root/.oh-my-zsh/custom/plugins/zsh-autosuggestions \
    && printf '%s\n' \
        'export ZSH="$HOME/.oh-my-zsh"' \
        'ZSH_THEME="bira"' \
        'ZSH_DISABLE_COMPFIX=true' \
        "zstyle ':omz:update' mode disabled" \
        'plugins=(git zsh-autosuggestions)' \
        'source $ZSH/oh-my-zsh.sh' \
        > /root/.zshrc
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
# cloudflared on PATH — `intentic apply` shells out to `cloudflared access tcp` to reach a self-host's SSH
# through its Cloudflare tunnel when the host is registered with via:"cloudflared" (a NAT'd local machine).
COPY --from=build /usr/local/bin/cloudflared /usr/local/bin/cloudflared
# The sandbox daemon.
COPY --from=build /out/sandbox /opt/sandbox
WORKDIR /work
ENV WORKSPACE_ROOT=/work SANDBOX_PORT=8787
EXPOSE 8787
ENTRYPOINT ["node", "/opt/sandbox/dist/main.js"]
