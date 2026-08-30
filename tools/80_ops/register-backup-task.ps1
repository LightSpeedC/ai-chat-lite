#Requires -Version 5.1
<#
.SYNOPSIS
	毎日のバックアップをタスクスケジューラに登録する。

.DESCRIPTION
	管理者権限は要らない。ログオンしているユーザーのタスクとして登録する。

	サービス（node-ai-chat-lite）とは別に動く。サービスを止める必要が
	ないため、バックアップの取得はサーバーの稼働と無関係に走ってよい。

	PC が寝ていて時刻を過ぎたときは、起きたあとに取り返す。

.PARAMETER At
	実行する時刻。既定は 03:00。

.PARAMETER Unregister
	登録を解除する。

.EXAMPLE
	.\register-backup-task.ps1
	.\register-backup-task.ps1 -At 12:30
	.\register-backup-task.ps1 -Unregister
#>
[CmdletBinding()]
param(
	[string] $At = '03:00',
	[switch] $Unregister
)

$ErrorActionPreference = 'Stop'

$taskName = 'ai-chat-lite バックアップ'
$script   = Join-Path $PSScriptRoot 'backup.ps1'

if ($Unregister) {
	if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
		Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
		Write-Host "登録を解除しました: $taskName"
	} else {
		Write-Host "登録されていません: $taskName"
	}
	return
}

$action = New-ScheduledTaskAction `
	-Execute 'powershell.exe' `
	-Argument ('-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $script)

$trigger = New-ScheduledTaskTrigger -Daily -At $At

# 電源とネットワークの条件を外す。ノート PC でバッテリー駆動でも走らせる
$settings = New-ScheduledTaskSettingsSet `
	-StartWhenAvailable `
	-AllowStartIfOnBatteries `
	-DontStopIfGoingOnBatteries `
	-ExecutionTimeLimit (New-TimeSpan -Minutes 10)

if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
	Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

Register-ScheduledTask `
	-TaskName $taskName `
	-Action $action `
	-Trigger $trigger `
	-Settings $settings `
	-Description 'ai-chat-lite の DB を _backup へ保存する（8 世代）' | Out-Null

Write-Host "登録しました: $taskName"
Write-Host ('  実行時刻: 毎日 {0}' -f $At)
Write-Host ('  実行内容: {0}' -f $script)
Write-Host ''
Write-Host 'いま試すには:'
Write-Host ('  Start-ScheduledTask -TaskName ''{0}''' -f $taskName)
