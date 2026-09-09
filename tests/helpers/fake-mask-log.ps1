<#
	mask-log-input.ps1 のテスト用の偽物。

	mask-log.ps1 と同じ引数を受け取り、必ず exit 1 で終わる。「子の終了コードを
	見て中止する」側（mask-log-input.ps1）だけを確かめたいので、本物を呼ばずに
	済ませる。呼ばれた回数は環境変数 MASK_LOG_TEST_CALL_LOG が指すファイルに
	1 行ずつ足す。1 回だけ足されていれば、WhatIfOnly の失敗で止まったと分かる。
#>
param(
	[string[]] $Word,
	[string] $Replacement,
	[switch] $WhatIfOnly
)

if ($env:MASK_LOG_TEST_CALL_LOG) {
	Add-Content -Path $env:MASK_LOG_TEST_CALL_LOG -Value 'called'
}

Write-Host '★ 本体の会話ログが見つかりません（テスト用の偽の失敗）'
exit 1
