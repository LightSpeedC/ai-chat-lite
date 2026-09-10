<#
	会話ログ（JSONL）の中の語を伏せ字に置き換える。

	Claude Code の会話ログには、応答やツールの出力に出た文字がそのまま残る。
	個人名・メールアドレス・ホスト名などが混じったときに、後から伏せるためのもの。

	置き換える語はこのファイルに書かない。実行するたびに入力する。
	書いてしまうと、伏せるためのスクリプト自体が残す側にまわる。

	【同名の cmd を持たない】
	-Word が必須なので、ダブルクリックでは動かない。入口は mask-log-input.ps1 で、
	そちらに mask-log-input.cmd が付いている。

	【必ずセッションを閉じてから実行する】
	ログは実行中のセッションが書き足している。開いたまま書き換えると、
	続きを書いた時点で伏せる前の内容が戻る。
#>
param(
	# 伏せたい語。複数渡せる
	[Parameter(Mandatory)] [string[]] $Word,

	# 置き換え後の文字列
	[string] $Replacement = '〈伏せ字〉',

	# 数えるだけで書き換えない
	[switch] $WhatIfOnly
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

<#
	会話ログの置き場は、プロジェクトのパスから決まる。区切り（: と \）を - に
	置き換えた名前になる（N:\ai-chat-lite → N--ai-chat-lite）。

	名前を決め打ちにしていたため、プロジェクトを移したときに黙って対象から
	外れていた。伏せられるのは etc\history\jsonl のコピーだけになり、
	次のセッションで本体からコピーし直されて伏せた分が戻る形だった。

	前方一致で探してはいけない。N--ai-chat-lite は N--ai-chat-lite-reviewer に
	当たり、他プロジェクトのログを書き換えることになる。
#>
$projectKey = ($root -replace '[:\\/]', '-')

$mainLog = Join-Path $env:USERPROFILE ".claude\projects\$projectKey"
$targets = @(
	$mainLog
	Join-Path $root 'etc\history\jsonl'
)

# --- 実行中のセッションが無いか確かめる ---
$running = Get-Process -Name 'claude' -ErrorAction SilentlyContinue
if ($running) {
	Write-Host '★ claude が動いています。セッションを閉じてから実行してください。' -ForegroundColor Yellow
	Write-Host ('  pid: ' + ($running.Id -join ', '))
	if (-not $WhatIfOnly) { return }
}

$totalHit = 0
$totalFile = 0

# 表示するパスからユーザー名を隠す。伏せるための道具が漏らしては元も子もない
function Format-Path {
	param([string] $Path)
	return $Path.Replace($env:USERPROFILE, '~')
}

foreach ($dir in $targets) {
	if (-not (Test-Path $dir)) {
		Write-Host ("  対象がありません: {0}" -f (Format-Path $dir))
		continue
	}
	Write-Host ("=== {0} ===" -f (Format-Path $dir))

	foreach ($f in Get-ChildItem $dir -Filter '*.jsonl' -File) {
		$text = [IO.File]::ReadAllText($f.FullName)
		$hit = 0
		foreach ($w in $Word) {
			$n = ([regex]::Matches($text, [regex]::Escape($w), 'IgnoreCase')).Count
			if ($n -gt 0) {
				$hit += $n
				$text = [regex]::Replace($text, [regex]::Escape($w), $Replacement, 'IgnoreCase')
			}
		}

		if ($hit -eq 0) {
			Write-Host ("  {0,-46} 0 件" -f $f.Name)
			continue
		}

		$totalHit += $hit
		$totalFile++

		if ($WhatIfOnly) {
			Write-Host ("  {0,-46} {1} 件（数えただけ）" -f $f.Name, $hit)
		} else {
			# JSONL は 1 行 1 レコード。改行を変えずに書き戻す
			[IO.File]::WriteAllText($f.FullName, $text, (New-Object Text.UTF8Encoding $false))
			Write-Host ("  {0,-46} {1} 件を伏せました" -f $f.Name, $hit)
		}
	}
}

Write-Host ''

<#
	本体が無いまま「伏せました」「残っていません」と出してはいけない。

	コピーの側だけを伏せても、次のセッションでフックが本体からコピーし直す。
	伏せたつもりで残る形になるため、ここで止めて場所を出す。
#>
if (-not (Test-Path $mainLog)) {
	Write-Host '★ 本体の会話ログが見つかりません。伏せても次のセッションで戻ります。' -ForegroundColor Red
	Write-Host ('  探した場所: ~\.claude\projects\{0}' -f $projectKey)
	Write-Host '  プロジェクトを移した直後なら、フォルダ名が変わっています'
	exit 1
}

if ($WhatIfOnly) {
	Write-Host ("{0} ファイル・{1} 件が見つかりました（書き換えていません）" -f $totalFile, $totalHit)
} elseif ($totalHit -eq 0) {
	Write-Host '残っている語はありませんでした。'
} else {
	Write-Host ("{0} ファイル・{1} 件を伏せました。" -f $totalFile, $totalHit)
	Write-Host '次にセッションを開くと、伏せた後のログがコピーされます。'
}

<#
	成功でも明示的に終了コードを返す。

	PowerShell では .ps1 が exit を通らずに終わると $LASTEXITCODE が更新されない。
	powershell.exe -File は毎回まっさらなセッションなので、呼び出し側から見ると
	最初の呼び出しでは未定義（$null）のままになる。$null -ne 0 は真なので、
	終了コードを見る側は成功を失敗と読む（レビュー #22 high 1。実測で再現した）。

	上の exit 1 と対にしておけば、呼ぶ側は $LASTEXITCODE だけで成否を判別できる。
#>
exit 0
