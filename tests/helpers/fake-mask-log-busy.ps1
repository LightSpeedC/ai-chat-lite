<#
	mask-log-input.ps1 のテスト用の偽物（claude が走っている版）。

	本物は claude が走っていると警告を出して exit 4 で止まる。下見の時点で
	止めるので、呼ぶ側は「セッションが開いている」と言えなければならない。
	「失敗しました」と出すと、閉じれば済む話が原因不明の失敗に見える。

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

Write-Host '★ claude が動いています。セッションを閉じてから実行してください。'
Write-Host '  pid: 12345'
Write-Host '  数えるだけの実行（-WhatIfOnly）も、ここで止めます'
exit 4
