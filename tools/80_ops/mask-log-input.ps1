<#
	mask-log.ps1 を対話で呼ぶ。ダブルクリックで使う入口。

	伏せたい語を尋ねてから渡すので、コマンドの履歴にも、このファイルにも語が残らない。
#>
param(
	# 呼び出す先の差し替え口。テストが偽物（必ず失敗する）に差し替えるためのもの。
	# 本番はここを渡さず、既定の mask-log.ps1 を使う
	[string] $MaskLogScript = (Join-Path $PSScriptRoot 'mask-log.ps1')
)

$ErrorActionPreference = 'Stop'

Write-Host '会話ログから語を伏せます。'
Write-Host '  カンマ区切りで複数指定できます。何も入れずに Enter で中止します。'
Write-Host ''

<#
	$input という名前は使わない。PowerShell の予約済み自動変数（パイプライン入力の
	列挙子）と衝突する。標準入力がリダイレクトされている状況（自動化・テスト）だと、
	Read-Host がここで読み取れずに固まったまま戻ってこない。対話的なコンソール起動
	（ダブルクリック運用）では表面化しないため、これまで気づかれずに残っていた
#>
$rawWords = Read-Host '伏せたい語'
if ([string]::IsNullOrWhiteSpace($rawWords)) {
	Write-Host '中止しました。'
	return
}
$words = $rawWords.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' }

$mask = Read-Host '置き換え後の文字列（既定: 〈伏せ字〉）'
if ([string]::IsNullOrWhiteSpace($mask)) { $mask = '〈伏せ字〉' }

<#
	呼ぶ前に 0 へ置く。

	.ps1 が exit を通らずに終わると $LASTEXITCODE は更新されない。
	powershell.exe -File は毎回まっさらなセッションなので、置かないと最初の
	呼び出しでは未定義（$null）のままで、$null -ne 0 が真になる。
	成功を失敗と読んで中止していた（レビュー #22 high 1。実測で再現した）。

	子（mask-log.ps1）は成功でも exit 0 を返すようにしたが、差し替えた側が
	そうでないこともあるので、こちら側でも前の値を持ち越さないようにする。
#>
# まず数えるだけ
Write-Host ''
Write-Host '--- 見つかった件数 ---'
$global:LASTEXITCODE = 0
& $MaskLogScript -Word $words -Replacement $mask -WhatIfOnly
if ($LASTEXITCODE -eq 4) {
	# claude が走っている。閉じれば済む話なので、失敗とは書き分ける
	Write-Host ''
	Write-Host 'セッションが開いているので中止します。閉じてから実行してください。' -ForegroundColor Yellow
	return
}
if ($LASTEXITCODE -ne 0) {
	Write-Host ''
	Write-Host '数えるだけの実行が失敗しました。中止します。' -ForegroundColor Red
	return
}

Write-Host ''
$ok = Read-Host 'この内容で伏せますか（yes と入力すると実行します）'
if ($ok -cne 'yes') {
	Write-Host '中止しました。'
	return
}

Write-Host ''
$global:LASTEXITCODE = 0
& $MaskLogScript -Word $words -Replacement $mask
if ($LASTEXITCODE -ne 0) {
	Write-Host ''
	Write-Host '伏せる処理が失敗しました。' -ForegroundColor Red
	return
}
