<#
.SYNOPSIS
  intentic cleanup (Windows) — remove intentic sandboxes' Docker footprint on THIS PC, INCLUDING the named volumes.

.DESCRIPTION
  A sandbox's /work is a NAMED Docker volume (intentic-workspace-<slug>). Removing a container "with volumes" only
  prunes ANONYMOUS volumes — a named volume survives, so a stale /work persists across re-runs and the daemon's boot
  gate then skips re-scaffolding. This removes the containers (incl. the Docker-in-Docker deploy target) AND the
  named volumes AND the networks. With a -Slug it removes just that one sandbox; with no arg it removes EVERY
  intentic sandbox, matched by name prefix. It leaves the platform's own resources (intentic-app-*) untouched.

.EXAMPLE
  irm https://intentic.dev/cleanup.ps1 | iex

.EXAMPLE
  ./cleanup.ps1 -Slug abc123def456
#>
param([string]$Slug)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Error 'docker is not installed — nothing to clean up.'
    exit 1
}

# A -Slug (as printed by connect.ps1's reset hint) targets just that instance; no arg matches every intentic
# sandbox by name prefix. Prefixes never overlap the platform's intentic-app-* resources. The sidecar container
# (intentic-sandbox-tunnel-<slug>) shares the intentic-sandbox- prefix, so the prefix pass catches it too.
if ($Slug) {
    $containers = @("intentic-sandbox-$Slug", "intentic-sandbox-tunnel-$Slug", "intentic-dind-host-$Slug")
    $volumes = @("intentic-workspace-$Slug", "intentic-history-$Slug", "intentic-dind-docker-$Slug")
    $networks = @("intentic-workspace-$Slug")
} else {
    $containers = @(docker ps -aq --filter 'name=intentic-sandbox-') + @(docker ps -aq --filter 'name=intentic-dind-host-')
    $volumes = @(docker volume ls -q --filter 'name=intentic-workspace-') + @(docker volume ls -q --filter 'name=intentic-history-') + @(docker volume ls -q --filter 'name=intentic-dind-docker-')
    $networks = @(docker network ls -q --filter 'name=intentic-workspace-')
}

Write-Host 'intentic: removing sandbox containers...'
foreach ($c in $containers) { if ($c) { docker rm -f $c *> $null } }

# "remove with volumes" prunes only ANONYMOUS volumes; the named /work volume must be removed explicitly.
Write-Host 'intentic: removing named volumes (the persistent /work)...'
foreach ($v in $volumes) { if ($v) { docker volume rm $v *> $null } }

Write-Host 'intentic: removing sandbox network(s)...'
foreach ($n in $networks) { if ($n) { docker network rm $n *> $null } }

Write-Host 'intentic: sandbox Docker state removed (containers + named volumes + network). Re-run connect to start fresh.'
