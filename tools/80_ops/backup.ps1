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
$logsDir   = Join-Path $root 'logs'

# 記録は HTML で残す。WARN と ERROR を色で目立たせるため
. (Join-Path $PSScriptRoot 'log.ps1')

function Write-BackupLog {
	param(
		[ValidateSet('I', 'W', 'E')] [string] $Level,
		[string] $Message
	)
	Write-OpsLog -Level $Level -Kind $Kind -Message $Message -LogsDir $logsDir
}

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
<#
	ここだけ $ErrorActionPreference を緩める。

	2>&1 で受けた標準エラーは ErrorRecord として返る（下の選別がそれを前提に
	している）。Stop のままだと、backup.mjs が 1 行書いた時点で
	NativeCommandError が投げられて終わる。

	印と重なって「30 秒待ちます」が出たときがこれに当たり、待機の途中で落ちて
	いた。スナップショットまで作って zip を作らずに終わるため、控えは増えず、
	下のコメントが「ERROR で残す」と書いているその ERROR も書かれない。

	成否は $LASTEXITCODE で見る。& node は非ゼロでも例外を投げない
#>
$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
	$output = & node (Join-Path $PSScriptRoot 'backup.mjs') $Kind $workDir 2>&1
	$exitCode = $LASTEXITCODE
} finally {
	$ErrorActionPreference = $prevEap
}

<#
	標準エラーに出た説明から、記録に残す 1 行を選ぶ。

	待機の途中経過（「30 秒待ちます（1/10）」）は画面には要るが、ログには要らない。
	10 回待てば 10 行が並び、肝心の結論が埋もれる。最後の 1 行だけを採る。
#>
$stderrLines = @($output | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] } |
	ForEach-Object { $_.ToString().Trim() } | Where-Object { $_ })

$waitedFor = ($stderrLines | Where-Object { $_ -match '待ちます' } | Select-Object -First 1)
# 結論の 1 行だけを採る。待機の途中経過・印の中身・次回の案内は画面にだけ出す
$notes = ($stderrLines | Where-Object {
		$_ -notmatch '待ちます' -and $_ -notmatch '^今回は取得を見送' -and $_ -notmatch '^印の中身'
	} | Select-Object -Last 1)

# 何を待ったか。レベルの判定にも使う
$waitReason =
	if ($waitedFor -match 'バックアップの印') { '別のバックアップを待った' }
	elseif ($waitedFor -match 'メンテナンスの印') { 'メンテナンス中のため待った' }
	else { '' }

<#
	終了コード 2 は「印が消えず、取らずに終えた」。

	これを 0 で返してはいけない。メンテナンスの印を消し忘れると以後すべての
	控えが取れなくなるが、正常終了で流すとタスクの履歴が緑のまま並び、
	異常に見えない。数か月後に戻そうとして、控えが 1 本も無いことに気づく。
	理由がメンテナンスでも、控えが無いことに変わりはない。
#>
if ($exitCode -eq 2) {
	Write-BackupLog -Level E -Message ('諦め {0}' -f $notes)
	Remove-OldOpsLogs -LogsDir $logsDir
	Write-Host ''
	Write-Host '今回は取得できませんでした。'
	exit 1
}
if ($exitCode -ne 0) {
	Write-BackupLog -Level E -Message ('失敗 終了コード {0} {1}' -f $exitCode, $notes)
	throw "スナップショットの取得に失敗しました (終了コード $exitCode)"
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

$kept = [Math]::Min($all.Count, $Keep)

<#
	待った理由でレベルを変える。

	別のバックアップと重なるのは設計上起きないはずのこと。4 区分は 1 分ずらして
	あり、1 回の取得は 1 秒とかからない。待たされたなら前の実行が 60 倍以上
	長引いている。メンテナンス中に待つのは設計どおりの動作なので INFO のまま。
#>
$level = if ($waitedFor -match 'バックアップの印') { 'W' } else { 'I' }
$waited = if ($waitReason) { ' / ' + $waitReason } else { '' }

Write-BackupLog -Level $level -Message (
	'取得 {0} 件 / {1:N0} バイト / {2} ms / {3} 世代を保持 / {4}{5}' -f `
		[int] $info['messages'], $zipSize, $info['ms'], $kept, (Split-Path $zipPath -Leaf), $waited
)
Remove-OldOpsLogs -LogsDir $logsDir

Write-Host ''
Write-Host ('完了しました。{0} は {1} 世代を保持しています: {2}' -f $Kind, $kept, $backupDir)
Write-Host ('  ログ: {0}' -f (Get-OpsLogPath -Kind $Kind -LogsDir $logsDir))
