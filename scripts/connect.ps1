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
# Infra secrets `intentic apply` reads inside the sandbox; they ride into the sandbox container's env and are
# never sent to the platform. CLOUDFLARE_API_TOKEN is REQUIRED — Cloudflare is intentic's reachability fabric
# (the tunnel that connects services and exposes them); it is validated below. HOST_SSH_KEY is optional.
$HostSshKey = $env:HOST_SSH_KEY
$CloudflareApiToken = $env:CLOUDFLARE_API_TOKEN
# Decentralized access (opt-in): when GOOGLE_CLIENT_ID is set, the sandbox is exposed at sandbox-<id>.<zone>
# via its own Cloudflare tunnel and the browser talks to it directly (the daemon verifies the user's Google
# ID token). WEB_ORIGIN scopes the daemon's CORS; ZONE picks the zone when the token sees more than one.
$GoogleClientId = $env:GOOGLE_CLIENT_ID
$WebOrigin = $env:WEB_ORIGIN
$Zone = $env:ZONE
$CloudflaredImage = if ($env:CLOUDFLARED_IMAGE) { $env:CLOUDFLARED_IMAGE } else { 'cloudflare/cloudflared:2026.6.1' }
$TunnelToken = ''
$SandboxPublicUrl = ''

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

# Decentralized access (opt-in via GOOGLE_CLIENT_ID): create/refresh this sandbox's own Cloudflare tunnel +
# DNS via the intentic CLI bundled in the sandbox image (reusing the providers' Cloudflare client), which
# prints the connector token; cloudflared runs as a sidecar after the runner. Skipped when GOOGLE_CLIENT_ID is
# unset — the platform then reaches the sandbox via the runner's outbound WSS relay.
if ($GoogleClientId) {
    Write-Host 'intentic: creating the sandbox tunnel...'
    # --entrypoint intentic: the image's default entrypoint is the daemon; we want the bundled CLI instead.
    $tunnelArgs = @('run', '--rm', '--entrypoint', 'intentic', '-e', "CLOUDFLARE_API_TOKEN=$CloudflareApiToken", '-e', "CONNECT_TOKEN=$RunnerToken")
    if ($Zone) { $tunnelArgs += @('-e', "ZONE=$Zone") }
    $tunnelArgs += @($SandboxImage, 'sandbox-tunnel', '--service', 'http://intentic-sandbox-workspace:8787')
    $tunnelOut = & docker $tunnelArgs
    $TunnelToken = ($tunnelOut | Where-Object { $_ -like 'TUNNEL_TOKEN=*' } | Select-Object -First 1) -replace '^TUNNEL_TOKEN=', ''
    $SandboxHostname = ($tunnelOut | Where-Object { $_ -like 'SANDBOX_HOSTNAME=*' } | Select-Object -First 1) -replace '^SANDBOX_HOSTNAME=', ''
    if (-not $TunnelToken -or -not $SandboxHostname) {
        Write-Error 'failed to create the sandbox tunnel (see the output above).'
        exit 1
    }
    $SandboxPublicUrl = "https://$SandboxHostname"
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
    -e HOST_SSH_KEY=$HostSshKey `
    -e CLOUDFLARE_API_TOKEN=$CloudflareApiToken `
    -e GOOGLE_CLIENT_ID=$GoogleClientId `
    -e CONNECT_TOKEN=$RunnerToken `
    -e WEB_ORIGIN=$WebOrigin `
    -e SANDBOX_PUBLIC_URL=$SandboxPublicUrl `
    $RunnerImage | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Error 'failed to start the runner container (see the docker output above).'
    exit 1
}

# Start the sandbox tunnel connector (opt-in): cloudflared on the shared network routes sandbox-<id>.<zone>
# to the sandbox daemon. It retries until the runner has spawned the sandbox, so ordering is not critical.
if ($GoogleClientId) {
    Write-Host 'intentic: starting the sandbox tunnel connector...'
    docker rm -f intentic-sandbox-tunnel *> $null
    docker run -d --restart unless-stopped --name intentic-sandbox-tunnel --network $Network `
        $CloudflaredImage tunnel --no-autoupdate run --token $TunnelToken | Out-Null
}

Write-Host "intentic runner started and dialing $PlatformUrl."
Write-Host 'Return to the platform — setup will continue automatically once it connects.'
if ($SandboxPublicUrl) {
    Write-Host "Your sandbox will be reachable at $SandboxPublicUrl (DNS may take a few seconds to propagate)."
}
Write-Host "Logs: docker logs -f $Container   Stop: docker rm -f $Container"
