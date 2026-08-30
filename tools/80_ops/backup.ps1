#Requires -Version 5.1
<#
.SYNOPSIS
	ai-chat-lite の DB をバックアップする。

.DESCRIPTION
	サービスを止めずに実行できる。読み取り専用の接続で VACUUM INTO するため、
	動いているサーバーの書き込みを邪魔しない。

	出力は _backup\<区分>\chat-yyyymmdd-hhmmss.db.zip。サイズに関わらず
	常に圧縮する。区分ごとに残す世代数が違う。

	  hourly    8 世代（8 時間）
	  daily     7 世代（1 週間）
	  weekly    4 世代（1 か月）
	  monthly   6 世代（半年）

	メンテナンス中（_data\MAINTENANCE がある）や、別のバックアップが動いて
	いる間は待つ。30 秒おきに 10 回まで見に行き、消えなければ取らずに終える。
	取らなかった場合も終了コードは 0。失敗ではないため。

.PARAMETER Kind
	区分。hourly / daily / weekly / monthly のいずれか。既定は hourly。

.PARAMETER Keep
	残す世代数。省略すると区分ごとの既定値を使う。

.EXAMPLE
	.\backup.ps1
	.\backup.ps1 -Kind daily
	.\backup.ps1 -Kind monthly -Keep 12
#>
[CmdletBinding()]
param(
	[ValidateSet('hourly', 'daily', 'weekly', 'monthly')]
	[string] $Kind = 'hourly',
	[int] $Keep = 0
)

$ErrorActionPreference = 'Stop'

$root      = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$backupDir = Join-Path $root ('_backup\' + $Kind)
$workDir   = Join-Path $root ('tmp\backup-work\' + $Kind)

# 前回の作業跡が残っていると VACUUM INTO が「出力先が既にある」で止まる
if (Test-Path $workDir) {
	Remove-Item -LiteralPath $workDir -Recurse -Force
}

Write-Host ('[{0}] DB のスナップショットを取得しています...' -f $Kind)

<#
	Node 側で印を見て待ち、通れば VACUUM INTO する。結果を key=value で受け取る。

	終了コード 2 は「印が消えず、取らずに終えた」。これは失敗ではないので
	エラーにしない。メンテナンス中は想定内の状態で、タスクの履歴を赤くしても
	対処のしようがない。何が起きたかは Node 側が標準エラーに書いている
#>
$output = & node (Join-Path $PSScriptRoot 'backup.mjs') $Kind $workDir
if ($LASTEXITCODE -eq 2) {
	Write-Host ''
	Write-Host '今回は取得しませんでした。'
	exit 0
}
if ($LASTEXITCODE -ne 0) {
	throw "スナップショットの取得に失敗しました (終了コード $LASTEXITCODE)"
}

$info = @{}
foreach ($line in $output) {
	if ($line -match '^([a-z]+)=(.*)$') { $info[$Matches[1]] = $Matches[2] }
}

if ($Keep -le 0) { $Keep = [int] $info['keep'] }

$snapshot = $info['file']
$zipPath  = Join-Path $backupDir ($info['base'] + '.db.zip')

Write-Host ('  元の DB     : {0}' -f $info['src'])
Write-Host ('  発言数       : {0} 件' -f $info['messages'])
Write-Host ('  スナップショット: {0:N0} バイト（{1} ミリ秒）' -f [int] $info['bytes'], $info['ms'])

if (-not (Test-Path $backupDir)) {
	New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
}
if (Test-Path $zipPath) {
	# 同じ秒に 2 回実行した場合。上書きせず、そのまま知らせる
	throw "同じ名前のバックアップが既にあります: $zipPath"
}

Write-Host '圧縮しています...'
Compress-Archive -Path $snapshot -DestinationPath $zipPath -CompressionLevel Optimal

$zipSize = (Get-Item -LiteralPath $zipPath).Length
$ratio   = $zipSize / [int] $info['bytes']
Write-Host ('  {0}  {1:N0} バイト（元の {2:P1}）' -f (Split-Path $zipPath -Leaf), $zipSize, $ratio)

# 作業用のスナップショットは消す。zip だけを残す
Remove-Item -LiteralPath $workDir -Recurse -Force

# 世代の整理。名前に日時が入っているので、辞書順で並べれば時系列順になる
$all = @(Get-ChildItem -LiteralPath $backupDir -Filter 'chat-*.db.zip' | Sort-Object Name -Descending)
if ($all.Count -gt $Keep) {
	$stale = $all | Select-Object -Skip $Keep
	Write-Host ('{0} 世代を超えた {1} 件を削除します' -f $Keep, @($stale).Count)
	foreach ($f in $stale) {
		Remove-Item -LiteralPath $f.FullName -Force
		Write-Host ('  削除: {0}' -f $f.Name)
	}
}

Write-Host ''
Write-Host ('完了しました。{0} は {1} 世代を保持しています: {2}' -f $Kind, [Math]::Min($all.Count, $Keep), $backupDir)
