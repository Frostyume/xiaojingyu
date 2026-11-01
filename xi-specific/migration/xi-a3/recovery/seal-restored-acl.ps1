param([Parameter(Mandatory=$true)][string]$Root)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$rootPath=[IO.Path]::GetFullPath($Root)
$receipt=Get-Content -LiteralPath (Join-Path $rootPath 'RESTORE-VERIFIED.json') -Raw | ConvertFrom-Json
if($receipt.verified -ne $true -or $receipt.ciphertext_sha256 -notmatch '^[a-f0-9]{64}$'){throw 'Verified offline restore receipt required'}
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
# Verification only. Python applies DACL_SECURITY_INFORMATION directly so no
# SACL/owner privilege is requested by the PowerShell Set-Acl provider.
$checked=0
foreach($item in @((Get-Item -LiteralPath $rootPath))+@(Get-ChildItem -LiteralPath $rootPath -Recurse -Force)){
 if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Offline restore contains a link'}
 $actual=Get-Acl -LiteralPath $item.FullName
 foreach($access in $actual.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
  if($access.AccessControlType -eq 'Allow' -and $access.IdentityReference.Value -ne $sid.Value){throw 'Offline restore ACL not restricted'}
 }
 $checked++
}
@{restricted=$true;current_user_only_allow=$true;entries_checked=$checked;source_or_online_runtime_changed=$false} | ConvertTo-Json -Compress
