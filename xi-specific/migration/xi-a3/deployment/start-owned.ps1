param(
  [Parameter(Mandatory = $true)][string]$RuntimeRoot,
  [Parameter(Mandatory = $true)][string]$NodeExecutable
)
$ErrorActionPreference = 'Stop'
if (-not [IO.Path]::IsPathFullyQualified($RuntimeRoot) -or -not [IO.Path]::IsPathFullyQualified($NodeExecutable)) { throw 'Explicit absolute runtime root and Node executable required' }
if (-not (Test-Path -LiteralPath $NodeExecutable -PathType Leaf)) { throw 'Configured Node executable is unavailable' }
$manifest = Join-Path $RuntimeRoot 'launch-manifest.json'
$meta = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
if (-not $meta.activationReady -or $null -eq $meta.pending -or $meta.pending.Count -ne 0) { throw 'Private installation review is incomplete; no runtime started.' }
$entry = Join-Path $PSScriptRoot 'launch-owned.mjs'
# The external QQ bridge is supplied and started independently by the operator.
# This script never starts, stops or distributes that bridge.
$endpoint = [Uri]$meta.handoffPlan.oneBotEndpoint
if ($endpoint.Scheme -ne 'ws' -or $endpoint.Host -ne '127.0.0.1' -or $endpoint.Port -lt 1 -or $endpoint.UserInfo -or $endpoint.Query -or $endpoint.Fragment) { throw 'Explicit loopback QQ endpoint required' }
if (-not (Get-NetTCPConnection -LocalPort $endpoint.Port -State Listen -ErrorAction SilentlyContinue)) { throw 'Start and sign in to the operator-provided QQ bridge before starting this runtime.' }
$logRoot = Join-Path $RuntimeRoot 'logs'
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$arguments = @(('"' + $entry + '"'), '--manifest', ('"' + $manifest + '"'))
if (Test-Path -LiteralPath (Join-Path $RuntimeRoot 'handoff.lock')) { $arguments += '--recover-abandoned' }
$child = Start-Process -FilePath $NodeExecutable -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput (Join-Path $logRoot ($stamp + '.out.log')) -RedirectStandardError (Join-Path $logRoot ($stamp + '.err.log'))
exit $child.ExitCode
