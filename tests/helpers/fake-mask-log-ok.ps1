<#
	mask-log-input.ps1 のテスト用の偽物（成功する版）。

	本物の mask-log.ps1 の正常系と同じ形にする。つまり exit を呼ばず、
	return か末尾まで走って終わる。ネイティブコマンドも呼ばない。

	【なぜこの形が要るのか】
	PowerShell では .ps1 が exit を通らずに終わると $LASTEXITCODE が更新されない。
	powershell.exe -File は毎回まっさらなセッションなので、最初の呼び出しの
	時点では未定義（$null）で、$null -ne 0 は真になる。呼び出し側がそれを
	「失敗」と読むと、成功しているのに中止してしまう（レビュー #22 high 1）。
	必ず失敗する偽物だけでテストしていたため、この経路が見えていなかった。

	呼ばれた回数は環境変数 MASK_LOG_TEST_CALL_LOG が指すファイルに 1 行ずつ足す。
#>
param(
	[string[]] $Word,
	[string] $Replacement,
	[switch] $WhatIfOnly
)

if ($env:MASK_LOG_TEST_CALL_LOG) {
	Add-Content -Path $env:MASK_LOG_TEST_CALL_LOG -Value 'called'
}

if ($WhatIfOnly) {
	Write-Host '  （偽物）0 ファイル・0 件が見つかりました（書き換えていません）'
} else {
	Write-Host '  （偽物）残っている語はありませんでした。'
}
