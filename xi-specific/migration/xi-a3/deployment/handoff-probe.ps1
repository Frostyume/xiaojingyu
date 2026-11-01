$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$plan=[Console]::In.ReadToEnd() | ConvertFrom-Json
$errors=@();$processes=@();$listeners=@();$clients=@();$tasks=@();$observer=$null;$corePid=0;$launcherPid=0;$bootTimeUtc=$null;$identityProcesses=@();$lineageProcesses=@()
try{$bootTimeUtc=(Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime.ToUniversalTime().ToString('o')}catch{$errors+='boot-identity-unavailable'}
try{
 $receiptPath=Join-Path $plan.oldRuntimeRoot 'runtime.json'
 if(Test-Path -LiteralPath $receiptPath){$receipt=Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json;$corePid=[int]$receipt.pid;$launcherPid=[int]$receipt.supervisor}
}catch{$errors+='old-receipt-unreadable'}
try{
 $all=@(Get-CimInstance Win32_Process)
 $owner=@($all | Where-Object ProcessId -eq ([int]$plan.observerPid))
 if($owner.Count -ne 1){$errors+='owner-process-identity-unavailable'}
 else{$observer=@{pid=[int]$owner[0].ProcessId;creationTimeUtc=$owner[0].CreationDate.ToUniversalTime().ToString('o')}}
 foreach($inspectPid in @($plan.identitiesToInspect | Select-Object -Unique)){
  $found=@($all | Where-Object ProcessId -eq ([int]$inspectPid))
  if($found.Count -eq 0){$identityProcesses+=@{pid=[int]$inspectPid;exists=$false}}
  elseif($found.Count -eq 1){$identityProcesses+=@{pid=[int]$inspectPid;exists=$true;parentPid=[int]$found[0].ParentProcessId;creationTimeUtc=$found[0].CreationDate.ToUniversalTime().ToString('o')}}
  else{$errors+='process-identity-ambiguous'}
 }
 if($plan.includeLineage){foreach($item in $all){$lineageProcesses+=@{pid=[int]$item.ProcessId;parentPid=[int]$item.ParentProcessId;creationTimeUtc=if($item.CreationDate){$item.CreationDate.ToUniversalTime().ToString('o')}else{$null}}}}
 foreach($item in $all){
  if($item.ProcessId -in @($PID,[int]$plan.observerPid)){continue}
  $command=[string]$item.CommandLine;$roles=@();$runWhale=$command -match 'companion[/\\]run-whale\.mjs'
  if($runWhale -and $item.ProcessId -eq $corePid){$roles+='old_core'}elseif($runWhale){$roles+='old_launcher'}
  if($command -match 'companion[/\\](start-independent|start-whale)\.ps1'){$roles+='old_entry_host'}
  if($command.Replace('/','\').IndexOf(([string]$plan.oldRuntimeRoot).Replace('/','\'),[StringComparison]::OrdinalIgnoreCase) -ge 0 -and $command -notmatch 'handoff-probe\.ps1|handoff-gate\.mjs'){$roles+='runtime_path_process'}
  if($roles.Count){$processes+=@{pid=[int]$item.ProcessId;parentPid=[int]$item.ParentProcessId;name=$item.Name;executablePath=$item.ExecutablePath;creationTimeUtc=$item.CreationDate.ToUniversalTime().ToString('o');roles=@($roles);rawCommandLineWithheld=$true}}
  if($item.ProcessId -in @($corePid,$launcherPid) -and -not $runWhale){
   # A later boot or a birth after the old receipt proves PID reuse, not an old writer.
   $receiptStamp=$null;try{$receiptStamp=[DateTimeOffset]::Parse([string]$receipt.at).UtcDateTime}catch{}
   $knownReuse=$receiptStamp -and (([DateTimeOffset]::Parse($bootTimeUtc).UtcDateTime -gt $receiptStamp) -or ($item.CreationDate -and $item.CreationDate.ToUniversalTime() -gt $receiptStamp))
   if(-not $knownReuse){$errors+='receipt-process-identity-unverified'}
  }
 }
}catch{$all=@();$errors+='process-observation-failed'}
try{
 foreach($connection in @(Get-NetTCPConnection -ErrorAction Stop)){
  if($connection.State -eq 'Listen' -and $connection.LocalPort -eq ([int]$plan.oldCorePort)){$listeners+=@{port=[int]$connection.LocalPort;pid=[int]$connection.OwningProcess;address=$connection.LocalAddress}}
  if($connection.State -eq 'Established' -and $connection.RemotePort -eq ([int]$plan.oneBotPort) -and $connection.RemoteAddress -in @('127.0.0.1','::1','::ffff:127.0.0.1')){$clients+=@{pid=[int]$connection.OwningProcess;remotePort=[int]$connection.RemotePort;rawCommandLineWithheld=$true}}
 }
}catch{$errors+='tcp-observation-failed'}
try{
 $selectedFound=$false
 foreach($task in @(Get-ScheduledTask -ErrorAction Stop)){
  $selected=$task.TaskName -eq $plan.oldTaskName -and $task.TaskPath -eq $plan.oldTaskPath
  if($selected){$selectedFound=$true}
  $related=$selected
  foreach($action in @($task.Actions)){if(($action.Execute+' '+$action.Arguments) -match 'companion[/\\](start-independent|start-whale|run-whale)\.(ps1|mjs)'){$related=$true}}
  if($related){
   if($null -eq $task.Settings.Enabled -or $null -eq $task.State){$errors+='task-enabled-state-unavailable'}
   $tasks+=@{name=$task.TaskName;taskPath=$task.TaskPath;state=[string]$task.State;enabled=[bool]$task.Settings.Enabled;rawActionArgumentsWithheld=$true}
  }
 }
 if(-not $selectedFound){$errors+='selected-task-state-unavailable'}
}catch{$errors+='task-observation-failed'}
@{format='xi-owned-handoff-os-v1';status='observed';createdAt=[DateTimeOffset]::UtcNow.ToString('o');bootTimeUtc=$bootTimeUtc;observer=$observer;identityProcesses=@($identityProcesses);lineageProcesses=@($lineageProcesses);processes=@($processes);listeners=@($listeners);qqClients=@($clients);tasks=@($tasks);errors=@($errors);serviceApiCalls=0;servicesOrTasksChanged=$false} | ConvertTo-Json -Depth 8 -Compress
