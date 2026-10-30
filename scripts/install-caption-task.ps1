# 注册「自动给收藏表情补备注」的计划任务（每 30 分钟一次）。
# 需要时用 Unregister-ScheduledTask -TaskName 'qq-bridge-auto-caption' 删掉。

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction Stop).Source
$script = Join-Path $root 'scripts\auto-caption-stickers.mjs'
$taskName = 'qq-bridge-auto-caption'

if (-not (Test-Path $script)) { throw "找不到脚本：$script" }

$action = New-ScheduledTaskAction -Execute $node -Argument "`"$script`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 30) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
  -Description '给 qq-bridge 收藏表情里没有备注的图自动补画面描述与标签' -Force | Out-Null

Write-Host "已注册计划任务：$taskName"
Write-Host "  每 30 分钟运行：$script"
Write-Host "  日志：$(Join-Path $root 'state\auto-caption.log')"
Write-Host "  立即验证一次："
& $node $script
