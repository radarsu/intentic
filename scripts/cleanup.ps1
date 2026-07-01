<#
.SYNOPSIS
  intentic cleanup (Windows) — remove the sandbox's Docker footprint on THIS PC, INCLUDING the named volumes.

.DESCRIPTION
  The sandbox's /work is a NAMED Docker volume (intentic-workspace-workspace). Removing a container "with volumes"
  only prunes ANONYMOUS volumes — a named volume survives, so a stale /work persists across re-runs and the
  daemon's boot gate then skips re-scaffolding. This removes the containers (incl. the Docker-in-Docker deploy
  target) AND the named volumes AND the shared network, by EXACT name, so re-running connect starts clean. It
  leaves the platform's own resources (intentic-app-*) untouched.

.EXAMPLE
  irm https://raw.githubusercontent.com/radarsu/intentic/main/scripts/cleanup.ps1 | iex

.EXAMPLE
  ./cleanup.ps1
#>
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Error 'docker is not installed — nothing to clean up.'
    exit 1
}

Write-Host 'intentic: removing sandbox containers...'
foreach ($c in @('intentic-sandbox-workspace', 'intentic-sandbox-tunnel', 'intentic-dind-host')) {
    docker rm -f $c *> $null
}

# The step "remove with volumes" skips: named volumes must be removed explicitly. This is the persistent /work.
Write-Host 'intentic: removing named volumes (the persistent /work)...'
foreach ($v in @('intentic-workspace-workspace', 'intentic-dind-docker')) {
    docker volume rm $v *> $null
}

Write-Host 'intentic: removing the sandbox network...'
docker network rm intentic-workspace *> $null

Write-Host 'intentic: sandbox Docker state removed (containers + named volumes + network). Re-run connect to start fresh.'
