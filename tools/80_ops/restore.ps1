#Requires -Version 5.1
<#
.SYNOPSIS
	バックアップから DB を戻す。

.DESCRIPTION
	動いているサーバーに DB を掴まれたままでは入れ替えられないため、
	メンテナンスの印（_data\MAINTENANCE）を置いてからサーバーを落とす。
	印がある間、サービスは何度落ちても待機で止まる。入れ替えが済んで
	印を消すと、サーバーが自分から起動する。管理者権限は要らない。

	いまの DB は消さずに退避する。戻した中身が思っていたものと違ったとき、
	元に戻せるようにするため。

.PARAMETER Path
	戻す zip。省略すると最新のものを使う。

.PARAMETER Force
	確認を省く。タスクから呼ぶとき用。

.EXAMPLE
	.\restore.ps1
	.\restore.ps1 -Path ..\..\_backup\chat-20260830-123456.db.zip
#>
[CmdletBinding()]
param(
	[string] $Path,
	[switch] $Force
)

$ErrorActionPreference = 'Stop'

$root        = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$backupDir   = Join-Path $root '_backup'
$dataDir     = Join-Path $root '_data'
$dbPath      = Join-Path $dataDir 'chat.db'
$lockPath    = Join-Path $dataDir 'MAINTENANCE'
$workDir     = Join-Path $root 'tmp\restore-work'
$clientPath  = Join-Path $root 'src\client\chat.mjs'

# --- 戻す zip を決める ---

if (-not $Path) {
	$latest = Get-ChildItem -LiteralPath $backupDir -Filter 'chat-*.db.zip' -ErrorAction SilentlyContinue |
		Sort-Object Name -Descending | Select-Object -First 1
	if (-not $latest) {
		throw "バックアップが 1 つもありません: $backupDir"
	}
	$Path = $latest.FullName
}
$Path = (Resolve-Path -LiteralPath $Path).Path

Write-Host ('戻す元 : {0}' -f $Path)
Write-Host ('戻す先 : {0}' -f $dbPath)
Write-Host ''

if (-not $Force) {
	Write-Host 'いまの DB は _data\chat.db.前-yyyymmdd-hhmmss として退避します。'
	$answer = Read-Host 'この内容で戻しますか（yes と入力すると実行します）'
	if ($answer -cne 'yes') {
		Write-Host '中止しました。'
		exit 1
	}
}

# --- 1. メンテナンスの印を置く ---

$reason = 'バックアップから戻しています: ' + (Split-Path $Path -Leaf)
Set-Content -LiteralPath $lockPath -Value $reason -Encoding UTF8
Write-Host '[1/5] メンテナンスの印を置きました'

try {
	# --- 2. サーバーを落とす ---

	# stop ではなく restart を使う。ここは間違えやすい。
	#
	# stop は終了コード 0 で終わる。WinSW はそれを正常終了とみなし、
	# サービスごと停止する。そうなると印を消しても誰も起動せず、
	# 復旧には管理者権限での再開が要る。
	#
	# restart は終了コード 1。異常終了として扱われ、WinSW が 10 秒後に
	# 起動し直す。そのとき印があれば待機に入り、消えた時点で動き出す。
	# メンテナンスの印は、この再起動ループがあって初めて働く。
	#
	# chat.mjs は名乗る ID を求めるため、ここで与える。誰が落としたかが
	# サーバーのログに残る。参加登録はされない
	$env:AICHAT_ID = 'restore'

	# & node は終了コードが非ゼロでも例外を投げない。catch では拾えないので
	# $LASTEXITCODE を見る。握りつぶすと、止まっていないのに次へ進んでしまう
	$stopOutput = & node $clientPath restart 2>&1
	if ($LASTEXITCODE -eq 0) {
		Write-Host '[2/5] サーバーを落としました（10 秒後に起動し直します）'
	} else {
		# 動いていなければ「繋がりません」で失敗する。それは想定どおりなので、
		# ここでは止めず、DB が解放されているかどうかで判断する
		Write-Host '[2/5] サーバーは応答しませんでした（もともと止まっていた可能性）'
	}

	# 掴んでいたファイルが解放されるまで少し待つ
	$freed = $false
	foreach ($i in 1..20) {
		Start-Sleep -Milliseconds 250
		try {
			if (Test-Path $dbPath) {
				$fs = [System.IO.File]::Open($dbPath, 'Open', 'ReadWrite', 'None')
				$fs.Close()
			}
			$freed = $true
			break
		} catch {
			# まだ掴まれている
		}
	}
	if (-not $freed) {
		$detail = if ($stopOutput) { "`n  停止の応答: " + (($stopOutput | Out-String).Trim() -replace "`r?`n", "`n  ") } else { '' }
		throw "DB が解放されませんでした。サーバーが止まっているか確認してください$detail"
	}

	# --- 3. 展開する ---

	if (Test-Path $workDir) { Remove-Item -LiteralPath $workDir -Recurse -Force }
	New-Item -ItemType Directory -Path $workDir | Out-Null
	Expand-Archive -LiteralPath $Path -DestinationPath $workDir

	$restored = Join-Path $workDir 'chat.db'
	if (-not (Test-Path $restored)) {
		throw "zip の中に chat.db がありません: $Path"
	}

	# 中身を確かめてから入れ替える。壊れた zip で上書きしないため
	$check = & node -e @'
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1], { readOnly: true });
const r = db.prepare('SELECT count(*) AS c, max(msg_seq) AS m FROM messages').get();
db.close();
console.log(r.c + ' 件 / 最大 msg_seq ' + (r.m ?? 'なし'));
'@ $restored
	if ($LASTEXITCODE -ne 0) {
		throw '展開した DB を読めませんでした'
	}
	Write-Host ('[3/5] 展開しました: {0}' -f $check)

	# --- 4. 入れ替える ---

	$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
	if (Test-Path $dbPath) {
		Move-Item -LiteralPath $dbPath -Destination "$dbPath.前-$stamp"
	}
	# WAL と共有メモリは古い DB のものなので、必ず捨てる。
	# 残したまま新しい本体を置くと、SQLite が食い違いを見て壊れたと判断する
	foreach ($suffix in '-wal', '-shm') {
		$sidecar = $dbPath + $suffix
		if (Test-Path $sidecar) { Remove-Item -LiteralPath $sidecar -Force }
	}
	Move-Item -LiteralPath $restored -Destination $dbPath
	Write-Host '[4/5] 入れ替えました（いまの DB は chat.db.前-… として残しています）'

} finally {
	# --- 5. 印を消す。途中で失敗しても必ず消す ---
	if (Test-Path $lockPath) {
		Remove-Item -LiteralPath $lockPath -Force
	}
	Write-Host '[5/5] メンテナンスの印を消しました。サーバーが自分から起動します'
}

Write-Host ''
Write-Host '完了しました。数秒で起動します。'
Write-Host '  確認: http://localhost:8787/'
