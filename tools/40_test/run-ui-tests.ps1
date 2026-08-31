#Requires -Version 7
<#
	画面のテストを通しで回す。

	  1. テスト用サーバーを立てる（本番とは別のポート・別の DB）
	  2. Playwright を回す
	  3. サーバーを止めて DB を捨てる

	本番へ向けて走らせないための入口。本番には他プロジェクトの AI が
	待ち受けているため、テストの投稿にも返事が来る。

	  run-ui-tests.ps1                  すべて
	  run-ui-tests.ps1 chat-ui          名前で絞る
	  run-ui-tests.ps1 -KeepServer      終わってもサーバーを残す（続けて何度も回すとき）
#>
param(
	# spec の名前の一部。省略するとすべて
	[string] $Filter = '',

	# 終わってもサーバーを止めない
	[switch] $KeepServer
)

$ErrorActionPreference = 'Stop'

$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$playwright = 'N:\2026\PlayWright'
$starter = Join-Path $PSScriptRoot 'start-test-server.mjs'

<#
	テストの置き場。これ 1 つで、DB も印も接続情報も決まる。
	既定でなければテスト用として動く（config.mjs の IS_TEST）。
#>
$env:AICHAT_DATA = Join-Path $root 'tmp\_data'

# 対象を組み立てる。名前で絞るときは spec 名の一部を渡す
$target = if ($Filter) { "projects/ai-chat-lite/$Filter" } else { 'projects/ai-chat-lite' }

Write-Host '=== ai-chat-lite 画面テスト ==='
Write-Host "  対象:   $target"
Write-Host "  置き場: $($env:AICHAT_DATA.Replace($root, '.'))"
Write-Host ''

# --- 1. 立てる ---

Write-Host '--- テスト用サーバー ---'
& node $starter
if ($LASTEXITCODE -ne 0) {
	Write-Host '立ち上がりませんでした。中止します。'
	exit 1
}

$code = 0
try {
	# --- 2. 回す ---

	Write-Host ''
	Write-Host '--- Playwright ---'
	Push-Location $playwright
	try {
		# コントラスト検査の対象をこのプロジェクトに向ける
		$env:CONTRAST_TARGET_DIR = $root
		npm run test:projects -- $target
		$code = $LASTEXITCODE
	} finally {
		Pop-Location
	}
} finally {
	# --- 3. 止める ---
	#
	# テストが落ちても必ず止める。立てっぱなしにするとポートを占め、
	# 次に走らせたとき別のポートへ逃げて紛らわしい。

	if ($KeepServer) {
		Write-Host ''
		Write-Host '--- サーバーは残しました（-KeepServer）---'
	} else {
		Write-Host ''
		Write-Host '--- 後始末 ---'
		& node $starter --stop
	}
}

Write-Host ''
if ($code -eq 0) {
	Write-Host 'すべて通りました'
} else {
	Write-Host "失敗したテストがあります（終了コード $code）"
}

exit $code
