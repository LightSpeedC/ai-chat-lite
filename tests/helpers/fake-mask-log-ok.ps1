<#
	mask-log-input.ps1 のテスト用の偽物（成功する版）。

	再現するのは「exit を通らずに終わる子」である。exit を呼ばず、
	末尾まで走って終わる。ネイティブコマンドも呼ばない。

	【本物の形とは違う】
	本物の mask-log.ps1 は末尾に exit 0 を持つようになった（レビュー #22
	high 1 の直し）。ただし claude が走っているときのトップレベル return
	（mask-log.ps1:56）はいまも exit を通らないので、この形は本物にも残って
	いる。そこをどう終わらせるかは i260911-01 の high 1 で見る。

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
