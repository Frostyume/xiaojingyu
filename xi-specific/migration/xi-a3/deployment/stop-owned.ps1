param([Parameter(Mandatory = $true)][string]$RuntimeRoot, [ValidateRange(1, 600)][int]$TimeoutSeconds = 45)
$ErrorActionPreference = 'Stop'
if (-not [IO.Path]::IsPathFullyQualified($RuntimeRoot)) { throw 'Explicit absolute runtime root required' }
$control = Get-Content -LiteralPath (Join-Path $RuntimeRoot 'launcher.json') -Raw | ConvertFrom-Json
if (-not $control.launchId -or $control.pid -le 0) { throw 'Missing owned launcher identity' }
$request = @{launchId=$control.launchId;pid=$control.pid;at=(Get-Date).ToUniversalTime().ToString('o')}
$file = Join-Path $RuntimeRoot 'stop-request.json'
[IO.File]::WriteAllText($file, ($request | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
do {
  Start-Sleep -Milliseconds 500
  $state = Get-Content -LiteralPath (Join-Path $RuntimeRoot 'runtime-status.json') -Raw | ConvertFrom-Json
  if ($state.state -eq 'stopped' -and $state.launchId -eq $control.launchId) {
    Write-Output 'Runtime saved state and exited normally.'
    exit 0
  }
} while ((Get-Date) -lt $deadline)
throw 'Runtime exit is unconfirmed; inspect owned-stop.json. Resources remain retained; no forced exit or competing instance was started.'
