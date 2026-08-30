#Requires -Version 5.1
<#
.SYNOPSIS
	バックアップと復旧の記録を HTML で残す。

.DESCRIPTION
	ドットソースで読み込んで使う。

	  . (Join-Path $PSScriptRoot 'log.ps1')
	  Write-OpsLog -Level W -Kind hourly -Message '別のバックアップを 30 秒待機'

	HTML にするのは WARN と ERROR を色で目立たせるため。テキストのログでは
	見分けるのに目を凝らす必要がある。

	1 行を <div> 1 つで書き、閉じタグ（</body> </html>）は書かない。
	ブラウザが補完するため、書き込みの途中で開いても壊れず、そこまでの行が
	読める。ログは書かれ続けるファイルなので、いつ開かれるか分からない。

	  logs\yyyymm-backup-hourly-log.html   hourly だけ
	  logs\yyyymm-backup-others-log.html   daily / weekly / monthly / restore
#>

# 12 か月より古いログは消す
$script:LOG_KEEP_MONTHS = 12

<#
	その区分のログの置き場。

	hourly だけ分けるのは、毎時走るため件数が他の 3 つを合わせた 20 倍以上に
	なるから。混ぜると monthly の年 12 行が埋もれる。
#>
function Get-OpsLogPath {
	param(
		[Parameter(Mandatory)] [string] $Kind,
		[Parameter(Mandatory)] [string] $LogsDir
	)
	$stamp = Get-Date -Format 'yyyyMM'
	$group = if ($Kind -eq 'hourly') { 'hourly' } else { 'others' }
	return Join-Path $LogsDir ('{0}-backup-{1}-log.html' -f $stamp, $group)
}

<#
	HTML の頭。ファイルが無いときだけ 1 度書く。

	色は WARN と ERROR にだけ付ける。INFO に付けると目立たせる意味がなくなる。
#>
function Get-OpsLogHeader {
	param([Parameter(Mandatory)] [string] $Title)
	return @"
<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="md-skip">
<title>$Title</title>
<style>
body { margin: 0; background: #fdfdfe; color: #1c2330; font-family: "Consolas", "Cascadia Mono", monospace; font-size: 13px; line-height: 1.7; }
h1 { background: linear-gradient(135deg, #12224d, #2f5fbf); color: #fff; font-size: 1.1em; padding: 12px 16px; margin: 0; font-family: "Segoe UI", "Yu Gothic UI", sans-serif; }
.log { padding: 8px 16px; }
.log div { white-space: pre-wrap; word-break: break-all; padding: 1px 6px; border-left: 4px solid transparent; }
.log div.I { background: transparent; color: #1c2330; }
.log div.W { background: #fff4e2; color: #7a3f00; border-left-color: #f0a548; font-weight: 700; }
.log div.E { background: #ffe9e9; color: #7a1416; border-left-color: #e05a5c; font-weight: 700; }
</style>
</head>
<body>
<h1>$Title</h1>
<div class="log">

"@
}

<#
	HTML の中で意味を持つ 3 文字を逃がす。

	& を先にすること。後にすると、先に置き換えた &lt; の & まで拾って
	&amp;lt; に化ける。
#>
function ConvertTo-OpsLogText {
	param([string] $Text)
	return $Text.Replace('&', '&amp;').Replace('<', '&lt;').Replace('>', '&gt;')
}

<#
	1 行追記する。

	本文の形式はテキストのログと同じ。先頭が固定長の JST 日時なので、
	行単位で並べ替えても時系列が崩れない。区分も固定幅にして絞り込める
	ようにする。

	書けなくても止めない。記録が残らないより、控えが取れない方が困る。
#>
function Write-OpsLog {
	param(
		[Parameter(Mandatory)] [ValidateSet('I', 'W', 'E')] [string] $Level,
		[Parameter(Mandatory)] [string] $Kind,
		[Parameter(Mandatory)] [string] $Message,
		[Parameter(Mandatory)] [string] $LogsDir
	)

	try {
		if (-not (Test-Path $LogsDir)) {
			New-Item -ItemType Directory -Path $LogsDir -Force | Out-Null
		}

		$path = Get-OpsLogPath -Kind $Kind -LogsDir $LogsDir
		if (-not (Test-Path $path)) {
			$group = if ($Kind -eq 'hourly') { 'hourly' } else { 'others' }
			$title = 'ai-chat-lite backup {0} {1}' -f $group, (Get-Date -Format 'yyyy-MM')
			# BOM 無し UTF-8。<meta charset> で宣言してある
			[System.IO.File]::WriteAllText($path, (Get-OpsLogHeader -Title $title), (New-Object System.Text.UTF8Encoding($false)))
		}

		$name = @{ I = 'INFO '; W = 'WARN '; E = 'ERROR' }[$Level]
		$line = '<div class={0}>{1} {2} [{3}] {4}</div>' -f `
			$Level,
			(Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'),
			$name,
			$Kind.PadRight(7),
			(ConvertTo-OpsLogText $Message)

		[System.IO.File]::AppendAllText($path, $line + "`r`n", (New-Object System.Text.UTF8Encoding($false)))
	} catch {
		Write-Host ('（ログを書けませんでした: {0}）' -f $_.Exception.Message)
	}
}

<# 12 か月より古いログを消す。名前の先頭 6 桁で判断する #>
function Remove-OldOpsLogs {
	param([Parameter(Mandatory)] [string] $LogsDir)

	if (-not (Test-Path $LogsDir)) { return }
	$cutoff = (Get-Date).AddMonths(-$script:LOG_KEEP_MONTHS).ToString('yyyyMM')

	# サービスのログ（WinSW が書くもの）に触れないよう、名前の形で絞る
	foreach ($f in Get-ChildItem -LiteralPath $LogsDir -Filter '*-backup-*-log.html' -File) {
		if ($f.Name -match '^(\d{6})-' -and $Matches[1] -lt $cutoff) {
			Remove-Item -LiteralPath $f.FullName -Force
			Write-Host ('古いログを削除: {0}' -f $f.Name)
		}
	}
}
