#Requires -Version 7
<#
	mask-log.ps1 を対話で呼ぶ。ダブルクリックで使う入口。

	伏せたい語を尋ねてから渡すので、コマンドの履歴にも、このファイルにも語が残らない。
#>
$ErrorActionPreference = 'Stop'

Write-Host '会話ログから語を伏せます。'
Write-Host '  カンマ区切りで複数指定できます。何も入れずに Enter で中止します。'
Write-Host ''

$input = Read-Host '伏せたい語'
if ([string]::IsNullOrWhiteSpace($input)) {
	Write-Host '中止しました。'
	return
}
$words = $input.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' }

$mask = Read-Host '置き換え後の文字列（既定: 〈伏せ字〉）'
if ([string]::IsNullOrWhiteSpace($mask)) { $mask = '〈伏せ字〉' }

# まず数えるだけ
Write-Host ''
Write-Host '--- 見つかった件数 ---'
& (Join-Path $PSScriptRoot 'mask-log.ps1') -Word $words -Replacement $mask -WhatIfOnly

Write-Host ''
$ok = Read-Host 'この内容で伏せますか（yes と入力すると実行します）'
if ($ok -cne 'yes') {
	Write-Host '中止しました。'
	return
}

Write-Host ''
& (Join-Path $PSScriptRoot 'mask-log.ps1') -Word $words -Replacement $mask
