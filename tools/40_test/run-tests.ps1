# tests/ 配下のテストをすべて実行する。
# 依存パッケージは使わず、Node 標準のテストランナー（node --test）で回す。

$ErrorActionPreference = 'Stop'
$projectRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $projectRoot

Write-Output "=== ai-chat-lite テスト ==="
Write-Output "対象: $projectRoot\tests"
Write-Output ''

node --test tests/
$code = $LASTEXITCODE

Write-Output ''
if ($code -eq 0) {
	Write-Output 'すべて通りました'
} else {
	Write-Output "失敗したテストがあります（終了コード $code）"
}

exit $code
