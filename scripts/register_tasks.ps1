<#
  毎晩20:00の自動制作を Windows のタスクスケジューラに登録する。
  20:00にPCが切れていた日のために、ログオンの3分後にも起動する
  (直近の20:00の回が終わっていれば、run_daily.ps1 が何もせずに終わる)。
    powershell -ExecutionPolicy Bypass -File scripts\register_tasks.ps1

  止めたいとき : Disable-ScheduledTask -TaskName AIGame_Daily
  再開したいとき: Enable-ScheduledTask  -TaskName AIGame_Daily
  消したいとき  : Unregister-ScheduledTask -TaskName AIGame_Daily -Confirm:$false
#>

$ErrorActionPreference = 'Stop'

$taskName = 'AIGame_Daily'
$repo = Split-Path -Parent $PSScriptRoot
$script = Join-Path $repo 'scripts\run_daily.ps1'

if (-not (Test-Path $script)) {
    Write-Output "run_daily.ps1 が見つかりません: $script"
    exit 1
}

$action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument ('-NoProfile -ExecutionPolicy Bypass -File "' + $script + '"') `
    -WorkingDirectory $repo

$daily = New-ScheduledTaskTrigger -Daily -At '20:00'
$logon = New-ScheduledTaskTrigger -AtLogOn -User ($env:USERDOMAIN + '\' + $env:USERNAME)
$logon.Delay = 'PT3M'

# PCが消えていた日のぶんは、次に起動したときに追いかけて実行する
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Hours 5) `
    -MultipleInstances IgnoreNew

$principal = New-ScheduledTaskPrincipal `
    -UserId ($env:USERDOMAIN + '\' + $env:USERNAME) `
    -LogonType Interactive `
    -RunLevel Limited

$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($null -ne $existing) {
    Write-Output "既に登録されているので、登録し直します: $taskName"
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger @($daily, $logon) `
    -Settings $settings `
    -Principal $principal `
    -Description '毎晩20:00(とログオンの3分後)に、次に投稿するブラウザゲームを1本つくる' | Out-Null

Write-Output "登録しました: $taskName(毎日 20:00 / ログオンの3分後)"
Write-Output "対象: $script"
Write-Output ''
Write-Output '今すぐ試すなら: Start-ScheduledTask -TaskName AIGame_Daily'
Write-Output '止めるなら    : Disable-ScheduledTask -TaskName AIGame_Daily'
