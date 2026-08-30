#Requires -Version 5.1
<#
.SYNOPSIS
	バックアップのタスクを 4 つ登録する。

.DESCRIPTION
	管理者権限は要らない。ログオンしているユーザーのタスクとして登録する。

	  hourly    毎時 0 分        8 世代
	  daily     毎日 0 時 1 分   7 世代
	  weekly    月曜 0 時 2 分   4 世代
	  monthly   1 日 0 時 3 分   6 世代

	1 つのタスクを毎時動かして「いまどの区分か」を判定する作りにはしない。
	時刻で判定すると、PC が寝ていて時刻を過ぎた回を取りこぼす。タスク
	スケジューラの StartWhenAvailable は区分ごとに独立して取り返すため、
	そちらに任せる。

	時刻を 1 分ずつずらしてある。同時刻にすると 4 つが同じ DB を同時に読み、
	ファイル名の秒まで一致して衝突する。

	サービス（node-ai-chat-lite）とは別に動く。バックアップは読み取り専用の
	接続で行うため、サーバーが動いていても構わない。

.PARAMETER Unregister
	登録を解除する。

.EXAMPLE
	.\register-backup-tasks.ps1
	.\register-backup-tasks.ps1 -Unregister
#>
[CmdletBinding()]
param(
	[switch] $Unregister
)

$ErrorActionPreference = 'Stop'

$script = Join-Path $PSScriptRoot 'backup.ps1'
$prefix = 'ai-chat-lite バックアップ'

# 取る時刻をずらす。月曜 0 時には 4 つすべてが順に走る
$plans = @(
	@{ Kind = 'hourly';  Name = "$prefix (毎時)"; Keep = 8; Desc = '毎時 0 分 / 8 世代' }
	@{ Kind = 'daily';   Name = "$prefix (毎日)"; Keep = 7; Desc = '毎日 0 時 1 分 / 7 世代' }
	@{ Kind = 'weekly';  Name = "$prefix (毎週)"; Keep = 4; Desc = '月曜 0 時 2 分 / 4 世代' }
	@{ Kind = 'monthly'; Name = "$prefix (毎月)"; Keep = 6; Desc = '1 日 0 時 3 分 / 6 世代' }
)

if ($Unregister) {
	foreach ($p in $plans) {
		if (Get-ScheduledTask -TaskName $p.Name -ErrorAction SilentlyContinue) {
			Unregister-ScheduledTask -TaskName $p.Name -Confirm:$false
			Write-Host ('解除しました: {0}' -f $p.Name)
		} else {
			Write-Host ('登録されていません: {0}' -f $p.Name)
		}
	}
	return
}

# 電源とネットワークの条件を外す。ノート PC でバッテリー駆動でも走らせる
$settings = New-ScheduledTaskSettingsSet `
	-StartWhenAvailable `
	-AllowStartIfOnBatteries `
	-DontStopIfGoingOnBatteries `
	-ExecutionTimeLimit (New-TimeSpan -Minutes 10)

foreach ($p in $plans) {
	$action = New-ScheduledTaskAction `
		-Execute 'powershell.exe' `
		-Argument ('-NoProfile -ExecutionPolicy Bypass -File "{0}" -Kind {1}' -f $script, $p.Kind)

	$trigger = switch ($p.Kind) {
		'hourly' {
			# 毎時 0 分。1 日 1 回のトリガに繰り返しを足す形でしか作れない
			$t = New-ScheduledTaskTrigger -Daily -At '00:00'
			$t.Repetition = (New-ScheduledTaskTrigger -Once -At '00:00' `
				-RepetitionInterval (New-TimeSpan -Hours 1) `
				-RepetitionDuration (New-TimeSpan -Days 1)).Repetition
			$t
		}
		'daily'   { New-ScheduledTaskTrigger -Daily -At '00:01' }
		'weekly'  { New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At '00:02' }
		'monthly' {
			# 毎月 1 日。New-ScheduledTaskTrigger に月次が無いので、
			# 毎日 0 時 3 分に起こして backup.ps1 側では判定しない……のではなく、
			# CIM のクラスを直接組み立てる
			$c = Get-CimClass -ClassName MSFT_TaskMonthlyTrigger -Namespace Root/Microsoft/Windows/TaskScheduler
			$t = New-CimInstance -CimClass $c -ClientOnly
			$t.DaysOfMonth = 1
			$t.MonthsOfYear = 4095   # 1 月から 12 月まで全部（2^12 - 1）
			$t.StartBoundary = (Get-Date -Hour 0 -Minute 3 -Second 0).ToString('yyyy-MM-ddTHH:mm:ss')
			$t.Enabled = $true
			$t
		}
	}

	if (Get-ScheduledTask -TaskName $p.Name -ErrorAction SilentlyContinue) {
		Unregister-ScheduledTask -TaskName $p.Name -Confirm:$false
	}

	Register-ScheduledTask `
		-TaskName $p.Name `
		-Action $action `
		-Trigger $trigger `
		-Settings $settings `
		-Description ('ai-chat-lite の DB を _backup\{0} へ保存する（{1}）' -f $p.Kind, $p.Desc) | Out-Null

	Write-Host ('登録しました: {0}  {1}' -f $p.Name, $p.Desc)
}

Write-Host ''
Write-Host 'いま試すには:'
Write-Host ("  Start-ScheduledTask -TaskName '{0}'" -f $plans[0].Name)
Write-Host ''
Write-Host '一覧を見るには:'
Write-Host ("  Get-ScheduledTask -TaskName '{0}*' | Select-Object TaskName, State" -f $prefix)
