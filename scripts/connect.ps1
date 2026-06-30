<#
.SYNOPSIS
  intentic connect (Windows) — run the AI-agent workspace sandbox on THIS PC and expose it to your
  browser, so a user without their own server can drive a project from their machine.

.DESCRIPTION
  The platform mints a per-project connection token and hands you a one-liner. This creates the
  sandbox's OWN Cloudflare tunnel (sandbox-<id>.<zone> → the daemon, plus *.preview.<zone> → the app
  preview), starts the published sandbox image as a long-lived, UNPRIVILEGED container (no Docker
  socket), and runs a cloudflared sidecar. The browser then talks to the sandbox DIRECTLY over that
  tunnel — the daemon verifies your Google sign-in, and the platform stays off the command path. On
  boot the sandbox registers its public URL with the platform's directory, so its setup gate flips to
  "ready". Requires Docker Desktop in Linux-containers mode (the sandbox image is Linux).

.EXAMPLE
  $env:PLATFORM_URL='wss://platform.example/runner/gateway'; $env:RUNNER_TOKEN='<token>'; irm https://raw.githubusercontent.com/radarsu/intentic/main/scripts/connect.ps1 | iex

.EXAMPLE
  ./connect.ps1 -PlatformUrl wss://platform.example/runner/gateway -RunnerToken <token>
#>
param(
    [string]$PlatformUrl,
    [string]$RunnerToken
)
$ErrorActionPreference = 'Stop'
# Native commands (docker) are expected to exit non-zero on the probes below; we branch on $LASTEXITCODE
# ourselves. Disable the PS 7.4+ default that turns those non-zero exits into terminating errors.
$PSNativeCommandUseErrorActionPreference = $false

# Prefer explicit params (direct file invocation); fall back to env vars (the `irm | iex` one-liner path).
if (-not $PlatformUrl) { $PlatformUrl = $env:PLATFORM_URL }
if (-not $RunnerToken) { $RunnerToken = $env:RUNNER_TOKEN }
$SandboxImage = if ($env:SANDBOX_IMAGE) { $env:SANDBOX_IMAGE } else { 'ghcr.io/radarsu/intentic/sandbox:latest' }
# The app's dev/watch command + port the sandbox daemon runs; the port is exposed at *.preview.<zone>.
$DevCommand = if ($env:DEV_COMMAND) { $env:DEV_COMMAND } else { 'pnpm dev' }
$DevPort    = if ($env:DEV_PORT)    { $env:DEV_PORT }    else { '5173' }
# Infra secrets `intentic apply` reads inside the sandbox; they ride into the sandbox container's env and are
# never sent to the platform. CLOUDFLARE_API_TOKEN is REQUIRED — Cloudflare is intentic's reachability fabric
# (the tunnel that connects services, exposes them, AND carries browser→sandbox traffic); it is validated
# below. HOST_SSH_KEY/SELF_HOST_USER are optional (set when this machine is wired as a deploy target).
$HostSshKey = $env:HOST_SSH_KEY
$SelfHostUser = $env:SELF_HOST_USER
$CloudflareApiToken = $env:CLOUDFLARE_API_TOKEN
# Browser-direct access: the sandbox is exposed at sandbox-<id>.<zone> via its OWN Cloudflare tunnel and the
# browser talks to it directly — the daemon verifies the user's Google ID token (audience = GOOGLE_CLIENT_ID,
# the platform's public web client id) and binds the owner on first connect (gated by RUNNER_TOKEN). WEB_ORIGIN
# scopes the daemon's CORS; ZONE picks the zone when the token sees more than one.
$GoogleClientId = $env:GOOGLE_CLIENT_ID
$WebOrigin = $env:WEB_ORIGIN
$Zone = $env:ZONE
$CloudflaredImage = if ($env:CLOUDFLARED_IMAGE) { $env:CLOUDFLARED_IMAGE } else { 'cloudflare/cloudflared:2026.6.1' }
$TunnelToken = ''
$SandboxPublicUrl = ''

# One sandbox per machine; the name is fixed so the tunnel ingress + cloudflared sidecar resolve it by DNS on
# the shared network, and the workspace volume persists the cloned repos across re-runs.
$Container = 'intentic-sandbox-workspace'
$WorkspaceVolume = 'intentic-workspace-workspace'
$Network   = 'intentic-workspace'

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Error 'docker is not installed. Install Docker Desktop (Linux containers), then re-run.'
    exit 1
}
docker info *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Error 'the docker daemon is not running. Start Docker Desktop, then re-run.'
    exit 1
}
if (-not $PlatformUrl -or -not $RunnerToken) {
    Write-Error 'PLATFORM_URL and RUNNER_TOKEN are required (env vars or -PlatformUrl/-RunnerToken).'
    exit 1
}
# The browser reaches the sandbox over a PUBLIC tunnel, so the daemon must authenticate every request against
# GOOGLE_CLIENT_ID. Without it the daemon would be open to the internet — refuse to start. The platform's setup
# one-liner always fills this in.
if (-not $GoogleClientId) {
    Write-Error 'GOOGLE_CLIENT_ID is required — it is the platform''s public Google web client id the sandbox verifies your browser sign-in against. Use the one-liner from the platform''s setup screen.'
    exit 1
}
# Cloudflare is intentic's reachability fabric (the tunnel that connects services and exposes them), so the
# token is required and validated up front rather than failing later at `intentic apply`. It never reaches the
# platform — it rides into the sandbox below. Verify it against Cloudflare's token-verify endpoint.
if (-not $CloudflareApiToken) {
    Write-Error 'CLOUDFLARE_API_TOKEN is required — Cloudflare is intentic''s reachability fabric (the tunnel that connects your services and exposes them). Create a token at https://dash.cloudflare.com/profile/api-tokens with Zone:Read, DNS:Edit, Cloudflare Tunnel:Edit.'
    exit 1
}
Write-Host 'intentic: validating Cloudflare API token...'
try {
    $cfVerify = Invoke-RestMethod -Uri 'https://api.cloudflare.com/client/v4/user/tokens/verify' -Headers @{ Authorization = "Bearer $CloudflareApiToken" }
} catch {
    $cfVerify = $null
}
if (-not $cfVerify -or -not $cfVerify.success -or $cfVerify.result.status -ne 'active') {
    Write-Error 'the Cloudflare API token is invalid or inactive (token verify failed). Re-check the token and its scopes (Zone:Read, DNS:Edit, Cloudflare Tunnel:Edit) at https://dash.cloudflare.com/profile/api-tokens.'
    exit 1
}

# Create/refresh this sandbox's own Cloudflare tunnel + DNS via the intentic CLI bundled in the sandbox image
# (reusing the providers' Cloudflare client), which prints the connector token: sandbox-<id>.<zone> → the
# daemon (:8787) and *.preview.<zone> → the app dev server (:$DevPort). cloudflared runs as a sidecar below.
Write-Host 'intentic: creating the sandbox tunnel...'
# --entrypoint intentic: the image's default entrypoint is the daemon; we want the bundled CLI instead.
$tunnelArgs = @('run', '--rm', '--entrypoint', 'intentic', '-e', "CLOUDFLARE_API_TOKEN=$CloudflareApiToken", '-e', "CONNECT_TOKEN=$RunnerToken")
if ($Zone) { $tunnelArgs += @('-e', "ZONE=$Zone") }
$tunnelArgs += @($SandboxImage, 'sandbox-tunnel', '--service', "http://${Container}:8787", '--preview-service', "http://${Container}:$DevPort")
$tunnelOut = & docker $tunnelArgs
$TunnelToken = ($tunnelOut | Where-Object { $_ -like 'TUNNEL_TOKEN=*' } | Select-Object -First 1) -replace '^TUNNEL_TOKEN=', ''
$SandboxHostname = ($tunnelOut | Where-Object { $_ -like 'SANDBOX_HOSTNAME=*' } | Select-Object -First 1) -replace '^SANDBOX_HOSTNAME=', ''
if (-not $TunnelToken -or -not $SandboxHostname) {
    Write-Error 'failed to create the sandbox tunnel (see the output above).'
    exit 1
}
$SandboxPublicUrl = "https://$SandboxHostname"

# cloudflared (the sidecar below) reaches the sandbox by container name on this shared network; create it first.
docker network inspect $Network *> $null
if ($LASTEXITCODE -ne 0) { docker network create $Network | Out-Null }
docker rm -f $Container *> $null

# Runs UNPRIVILEGED: no --user root and no Docker-socket mount — the sandbox no longer manages other
# containers, it IS the workspace. --add-host lets it reach the host it runs on at host.docker.internal (SSH
# self-host deploys target it). The workspace volume persists the cloned repos across re-runs. The daemon binds
# 0.0.0.0:8787 on the private network; only the Cloudflare tunnel exposes it (no host port is published).
docker run -d --restart unless-stopped --name $Container `
    --network $Network `
    --add-host host.docker.internal:host-gateway `
    -v "${WorkspaceVolume}:/work" `
    -e WORKSPACE_ROOT=/work `
    -e SANDBOX_HOST=0.0.0.0 `
    -e SANDBOX_PORT=8787 `
    -e SANDBOX_NAME=$Container `
    -e SANDBOX_IMAGE=$SandboxImage `
    -e "DEV_COMMAND=$DevCommand" `
    -e DEV_PORT=$DevPort `
    -e GOOGLE_CLIENT_ID=$GoogleClientId `
    -e CONNECT_TOKEN=$RunnerToken `
    -e WEB_ORIGIN=$WebOrigin `
    -e SANDBOX_PUBLIC_URL=$SandboxPublicUrl `
    -e PLATFORM_URL=$PlatformUrl `
    -e CLOUDFLARE_API_TOKEN=$CloudflareApiToken `
    -e HOST_SSH_KEY=$HostSshKey `
    -e SELF_HOST_USER=$SelfHostUser `
    $SandboxImage | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Error 'failed to start the sandbox container (see the docker output above).'
    exit 1
}

# Start the tunnel connector: cloudflared on the shared network routes sandbox-<id>.<zone> → the daemon and
# *.preview.<zone> → the app preview. It retries until the sandbox is up, so ordering is not critical.
Write-Host 'intentic: starting the sandbox tunnel connector...'
docker rm -f intentic-sandbox-tunnel *> $null
docker run -d --restart unless-stopped --name intentic-sandbox-tunnel --network $Network `
    $CloudflaredImage tunnel --no-autoupdate run --token $TunnelToken | Out-Null

Write-Host "intentic sandbox started and registering with $PlatformUrl."
Write-Host "Your sandbox will be reachable at $SandboxPublicUrl (DNS may take a few seconds to propagate)."
Write-Host 'Return to the platform — setup will continue automatically once it connects.'
Write-Host "Logs: docker logs -f $Container   Stop: docker rm -f $Container intentic-sandbox-tunnel"
