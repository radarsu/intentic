<#
.SYNOPSIS
  intentic connect (Windows) — run the AI-agent workspace runner on THIS PC and dial it back to an
  intentic platform, so a user without their own server can drive a sandbox from their machine.

.DESCRIPTION
  The platform mints a per-project runner token and hands you a one-liner. This starts the published
  runner image as a long-lived container that holds the local docker socket (so it can spawn the
  project's sandbox) and dials the platform's WSS gateway OUTBOUND with the token — no inbound port
  needed. Once connected, the platform's setup gate flips to "ready" on its own. Requires Docker
  Desktop in Linux-containers mode (the runner image is Linux). Same container the server-based
  i.want.workspace provider runs, minus the Cloudflare preview tunnel (a local PC has no zone).

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
$RunnerImage  = if ($env:RUNNER_IMAGE)  { $env:RUNNER_IMAGE }  else { 'ghcr.io/radarsu/intentic/runner:latest' }
$SandboxImage = if ($env:SANDBOX_IMAGE) { $env:SANDBOX_IMAGE } else { 'ghcr.io/radarsu/intentic/sandbox:latest' }
$PreviewPort  = if ($env:PREVIEW_PORT)  { $env:PREVIEW_PORT }  else { '8088' }

$Container = 'intentic-runner'
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

# The runner reaches each sandbox by container name on this shared network; create it before the run.
docker network inspect $Network *> $null
if ($LASTEXITCODE -ne 0) { docker network create $Network | Out-Null }
docker rm -f $Container *> $null

# --user root: the runner manages sandboxes through the mounted docker socket. host.docker.internal is how a
# self-hosted platform on this machine is reached; Docker Desktop resolves it without --add-host.
docker run -d --restart unless-stopped --user root --name $Container `
    --network $Network `
    -p "${PreviewPort}:${PreviewPort}" `
    -v /var/run/docker.sock:/var/run/docker.sock `
    -e PREVIEW_PORT=$PreviewPort `
    -e SANDBOX_IMAGE=$SandboxImage `
    -e PLATFORM_URL=$PlatformUrl `
    -e RUNNER_TOKEN=$RunnerToken `
    $RunnerImage | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Error 'failed to start the runner container (see the docker output above).'
    exit 1
}

Write-Host "intentic runner started and dialing $PlatformUrl."
Write-Host 'Return to the platform — setup will continue automatically once it connects.'
Write-Host "Logs: docker logs -f $Container   Stop: docker rm -f $Container"
