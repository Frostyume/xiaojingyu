param([string]$NodeExecutable = (Get-Command node -ErrorAction Stop).Source)
$ErrorActionPreference = 'Stop'
$packageRoot = Join-Path $PSScriptRoot 'migration/xi-a2'
$dependencyRoot = Join-Path $packageRoot 'node_modules'
$link = Join-Path $PSScriptRoot 'node_modules'
function Assert-PlainOwnedPath([string]$Target) {
  $root = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')
  $full = [IO.Path]::GetFullPath($Target)
  if (-not $full.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Dependency path is outside source directory' }
  $cursor = $root
  if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Source root must not be a link' }
  foreach ($part in $full.Substring($root.Length + 1).Split('\')) {
    $cursor = Join-Path $cursor $part
    if (Test-Path -LiteralPath $cursor) {
      $entry = Get-Item -LiteralPath $cursor -Force
      if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Dependency installation refuses linked directories before npm ci' }
      if (-not $entry.PSIsContainer) { throw 'Dependency path must be a directory' }
    }
  }
}
Assert-PlainOwnedPath $packageRoot
Assert-PlainOwnedPath $dependencyRoot
if (-not (Test-Path -LiteralPath $NodeExecutable -PathType Leaf)) { throw 'Explicit Node executable is required' }
if (Test-Path -LiteralPath $link) {
  $item = Get-Item -LiteralPath $link -Force
  if ($item.LinkType -ne 'Junction' -or [IO.Path]::GetFullPath([string]$item.Target) -ne [IO.Path]::GetFullPath($dependencyRoot)) {
    throw 'Existing node_modules is not this installer-owned dependency junction; nothing replaced'
  }
}
Push-Location $packageRoot
try {
  & npm ci --ignore-scripts --legacy-peer-deps --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed' }
  & $NodeExecutable (Join-Path $packageRoot 'tools/patch-snowluma-sdk.mjs')
  if ($LASTEXITCODE -ne 0) { throw 'Explicit SDK extension patch failed' }
} finally { Pop-Location }
if (-not (Test-Path -LiteralPath $link)) {
  New-Item -ItemType Junction -Path $link -Target $dependencyRoot | Out-Null
}
Write-Output 'Dependencies installed. No account, bridge, model, service or scheduled task was started.'
