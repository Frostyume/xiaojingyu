# Read-only known-writer/task/socket observation. Never stop/disable/kill anything.
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false)
$plan=[Console]::In.ReadToEnd() | ConvertFrom-Json
$blockers=@();$warnings=@();$tasks=@();$writers=@();$ports=@();$clients=@()
try {
 if(-not $plan.roots.Count -or -not $plan.tasks.Count -or -not $plan.ports.Count -or -not $plan.onebot_port){throw 'incomplete-plan'}
 $all=@(Get-CimInstance Win32_Process -ErrorAction Stop)
 foreach($item in $all){
  if($item.ProcessId -in @($PID,[int]$plan.observer_pid)){continue}
  $command=([string]$item.CommandLine).Replace('/','\');$matched=$false
  foreach($root in $plan.roots){if($command.IndexOf(([string]$root).Replace('/','\'),[StringComparison]::OrdinalIgnoreCase) -ge 0){$matched=$true}}
  if(-not $matched){continue}
  if($item.Name -match '^(node|python|pythonw|powershell|pwsh|cmd|wscript|cscript)\.exe$'){$writers+=@{pid=[int]$item.ProcessId;name=$item.Name};$blockers+='runtime-executor-present'}
  else{$warnings+=@{pid=[int]$item.ProcessId;name=$item.Name;classification=if($item.Name -match '^(notepad|notepad\+\+|code|wordpad)\.exe$'){'potential_manual_editor'}else{'unknown_observer'}}}
 }
 foreach($connection in @(Get-NetTCPConnection -ErrorAction Stop)){
  if($connection.State -eq 'Listen' -and $connection.LocalPort -in @($plan.ports)){$ports+=@{port=[int]$connection.LocalPort;pid=[int]$connection.OwningProcess};$blockers+='runtime-port-listening'}
  if($connection.State -eq 'Established' -and $connection.RemotePort -eq [int]$plan.onebot_port -and $connection.RemoteAddress -in @('127.0.0.1','::1','::ffff:127.0.0.1')){$clients+=@{pid=[int]$connection.OwningProcess};$blockers+='onebot-client-present'}
 }
 $allTasks=@(Get-ScheduledTask -ErrorAction Stop)
 foreach($required in $plan.tasks){
  $found=@($allTasks | Where-Object {$_.TaskName -eq $required.name -and $_.TaskPath -eq $required.path})
  if($found.Count -ne 1){$blockers+='task-not-observed-exactly-once';continue}
  $task=$found[0];$tasks+=@{name=$task.TaskName;path=$task.TaskPath;state=[string]$task.State;enabled=[bool]$task.Settings.Enabled}
  if($null -eq $task.Settings.Enabled -or $null -eq $task.State -or $task.Settings.Enabled -or [string]$task.State -ne 'Disabled'){$blockers+='automatic-entry-not-frozen'}
 }
 foreach($file in @($plan.must_be_absent)){if(Test-Path -LiteralPath $file){$blockers+='owned-lock-or-child-journal-retained'}}
} catch {$blockers+='os-observation-failed'}
@{format='xi-multi-root-os-gate-v1';allowed=($blockers.Count -eq 0);actual_os_probe=$true;observed_at=[DateTimeOffset]::UtcNow.ToString('o');blockers=@($blockers|Select-Object -Unique);writers=@($writers);tasks=@($tasks);ports=@($ports);onebot_clients=@($clients);warnings=@($warnings);raw_command_lines_withheld=$true;service_api_calls=0;services_or_tasks_changed=$false;scope='Known registered roots/tasks/ports and OneBot; caller retains external write barrier'} | ConvertTo-Json -Depth 8 -Compress
if($blockers.Count){exit 2}
