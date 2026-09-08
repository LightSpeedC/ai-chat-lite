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
	元に戻せるようにするため。chat.db / chat.db-wal / chat.db-shm の 3 つを
	まとめて _data\prev-yyyymmdd-hhmmss\ へ移す。1 つでも欠けると戻せない。

.PARAMETER Path
	戻す zip。省略すると最新のものを使う。

.PARAMETER Force
	確認を省く。タスクから呼ぶとき用。

.PARAMETER EstimatedMinutes
	再開までの見込み（分）。停止の案内と、メンテナンス中の Retry-After に使う。
	既定は 5 分。実測では 1 分前後で終わるが、短く言って外すより余裕を持たせる。

.EXAMPLE
	.\restore.ps1
	.\restore.ps1 -Path ..\..\_backup\chat-20260830-123456.db.zip
#>
[CmdletBinding()]
param(
	[string] $Path,
	[switch] $Force,
	[int] $EstimatedMinutes = 5
)

$ErrorActionPreference = 'Stop'

$root        = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$backupDir   = Join-Path $root '_backup'
$dataDir     = Join-Path $root '_data'
$dbPath      = Join-Path $dataDir 'chat.db'
$lockPath    = Join-Path $dataDir 'MAINTENANCE'
$workDir     = Join-Path $root 'tmp\restore-work'
$clientPath  = Join-Path $root 'src\client\chat.mjs'

# CLI は接続先の既定値を持たない。テストのつもりの操作が本番へ入るのを防ぐため、
# --port か --url を必ず渡す作りにしてある。ここは本番を戻すスクリプトなので本番のポート。
# 既定 8787 は config.mjs と同じ値。片方だけ変えると噛み合わなくなる
$serverPort  = if ($env:AICHAT_PORT) { $env:AICHAT_PORT } else { 8787 }
$logsDir     = Join-Path $root 'logs'

# 記録は others のログへ。復旧は頻度が低いので hourly と分ける必要がない
. (Join-Path $PSScriptRoot 'log.ps1')

# --- 戻す zip を決める ---

if (-not $Path) {
	# 全区分から新しい順に並べて先頭を採る。名前に日時が入っているので
	# 名前で並べれば時系列順になる。更新日時はコピーや展開で変わるため使わない
	$candidates = @()
	foreach ($kind in 'hourly', 'daily', 'weekly', 'monthly') {
		$dir = Join-Path $backupDir $kind
		if (Test-Path $dir) {
			$candidates += Get-ChildItem -LiteralPath $dir -Filter 'chat-*.db.zip'
		}
	}
	# 区分を分ける前に取ったものも拾う
	if (Test-Path $backupDir) {
		$candidates += Get-ChildItem -LiteralPath $backupDir -Filter 'chat-*.db.zip'
	}

	$latest = $candidates | Sort-Object Name -Descending | Select-Object -First 1
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
	Write-Host 'いまの DB は 3 つとも _data\prev-yyyymmdd-hhmmss\ へ退避します。'
	$answer = Read-Host 'この内容で戻しますか（yes と入力すると実行します）'
	if ($answer -cne 'yes') {
		Write-Host '中止しました。'
		exit 1
	}
}

# --- 0. これから止めることを知らせる ---

# 印を置く前に投稿する。印を置いてから投稿すると、もう受け付けてもらえない。
#
# 案内を出してすぐ落とすと読めないので、10 秒待つ。待受けは long-poll なので
# 投稿は即座に届き、読ませるだけならこれで足りる。止めたい側を長く待たせない
# ことを優先している。
#
# 素の restart（コードの入れ替え）では投稿しない。案内を出すのはこの手順を
# 通ったときだけ、という条件がこれで自然に満たされる。
$reason = 'バックアップから戻しています: ' + (Split-Path $Path -Leaf)
$notice = @"
【メンテナンス】これから停止します。$reason
見込み: 約 $EstimatedMinutes 分
再開したらこのルームに知らせます。それまで待受けは繋がりません。
"@

$sayOutput = & node $clientPath say $notice --port $serverPort --connector-id ai-chat-lite 2>&1
if ($LASTEXITCODE -eq 0) {
	Write-Host '[0/5] 停止することを知らせました（10 秒待ちます）'
	Start-Sleep -Seconds 10
} else {
	# 止まっているなら知らせる相手もいない。ここで止める理由はない
	Write-Host '[0/5] 知らせられませんでした（すでに止まっている可能性）'
}

# --- 1. メンテナンスの印を置く ---

# 見込みは「見込み: N 分」の行で渡す。サーバーはこれを読んで Retry-After に入れる
Set-Content -LiteralPath $lockPath -Value "$reason`n見込み: $EstimatedMinutes 分" -Encoding UTF8
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

	# & node は終了コードが非ゼロでも例外を投げない。catch では拾えないので
	# $LASTEXITCODE を見る。握りつぶすと、止まっていないのに次へ進んでしまう
	$stopOutput = & node $clientPath restart --port $serverPort --connector-id restore 2>&1
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

	<#
		--- 4. 入れ替える ---

		いまの DB は 3 つのファイルで 1 組になっている。chat.db だけを残しても
		戻せない。サーバーが閉じずに終わると発言の大半は chat.db-wal 側に残り、
		本体は空同然になるため。実測では 64 件のうち 0 件しか本体に無かった。

		3 つまとめてフォルダへ移す。個別にリネームすると _data 直下が散らかり、
		どれが同じ組なのか名前を突き合わせないと分からなくなる。
	#>
	$stamp   = Get-Date -Format 'yyyyMMdd-HHmmss'
	$prevDir = Join-Path $dataDir "prev-$stamp"
	New-Item -ItemType Directory -Path $prevDir | Out-Null

	$moved = @()
	foreach ($suffix in '', '-wal', '-shm') {
		$sidecar = $dbPath + $suffix
		if (Test-Path $sidecar) {
			Move-Item -LiteralPath $sidecar -Destination (Join-Path $prevDir ('chat.db' + $suffix))
			$moved += 'chat.db' + $suffix
		}
	}

	Move-Item -LiteralPath $restored -Destination $dbPath
	Write-Host ('[4/5] 入れ替えました（前の {0} を {1} に残しています）' -f ($moved -join ' / '), (Split-Path $prevDir -Leaf))

	Write-OpsLog -Level I -Kind restore -LogsDir $logsDir -Message (
		'復旧 {0} から {1} / 前の DB は {2} へ' -f (Split-Path $Path -Leaf), $check, (Split-Path $prevDir -Leaf)
	)

	<#
		--- 5. 印を消す。入れ替えが終わったときだけ ---

		失敗した経路では消さない。危ないのは chat.db を prev- へ移したあと、
		控えを置く前に落ちた場合で、このとき DB が無い状態になる。

		印を消せばサーバーが起動し、DatabaseSync は無ければ作るため、
		空の DB に版が当たって本番として立ち上がる。唯一の現物は prev- に
		残ったまま、参加者には「取りこぼしなし」が流れる。

		止まったままのほうが直せる。印は人が確かめてから消す。
	#>
	if (Test-Path $lockPath) {
		Remove-Item -LiteralPath $lockPath -Force
	}
	Write-Host '[5/5] メンテナンスの印を消しました。サーバーが自分から起動します'

} catch {
	# 途中で止まった場合も記録に残す。DB が中途半端な状態かもしれない
	Write-OpsLog -Level E -Kind restore -LogsDir $logsDir -Message (
		'復旧に失敗 {0} / {1}' -f (Split-Path $Path -Leaf), ($_.Exception.Message -replace "`r?`n", ' ')
	)

	<#
		印を残す。DB が無い・中途半端なまま起動させないため。

		どこで落ちたかは人が見て判断する。見るべき場所を出しておく。
	#>
	if (Test-Path $lockPath) {
		Write-Host ''
		Write-Host 'メンテナンスの印を残しました。サーバーは起動しません' -ForegroundColor Yellow
		Write-Host '  印   _data\MAINTENANCE'
		if (Test-Path $dbPath) {
			Write-Host '  DB   _data\chat.db … あります'
		} else {
			Write-Host '  DB   _data\chat.db … ありません' -ForegroundColor Red
			Write-Host '       入れ替えの途中で止まっています。prev- の中身を戻してください' -ForegroundColor Red
		}
		if ($prevDir -and (Test-Path $prevDir)) {
			Write-Host ('  控え _data\{0}' -f (Split-Path $prevDir -Leaf))
		}
		Write-Host '  中身を確かめたら、印を消すとサーバーが自分から起動します'
	}
	throw
}

Write-Host ''
Write-Host '完了しました。数秒で起動します。'
Write-Host '  確認: http://localhost:8787/'
