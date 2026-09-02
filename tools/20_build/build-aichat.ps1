#Requires -Version 7
<#
	C# 版 CLI（aichat.exe）を作る。

	  1. options.mjs から定義を JSON に書き出す
	  2. csc でコンパイルし、その JSON を埋め込む
	  3. root に aichat.exe を置く

	csc は .NET Framework に同梱されているので、SDK の導入は要らない。
	出力は Git 管理外（.gitignore に書いてある）。作り直せるものを履歴に入れない。

	  build-aichat.ps1              作る
	  build-aichat.ps1 -Check       作ったあと --help を出して確かめる
#>
param(
	# 作ったあと動かして確かめる
	[switch] $Check
)

$ErrorActionPreference = 'Stop'

$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$srcDir = Join-Path $root 'src/cli-cs'
$outExe = Join-Path $root 'aichat.exe'
$optionsJson = Join-Path $root 'tmp/cli-options.json'

Write-Host '=== aichat.exe をビルドします ==='
Write-Host ''

# --- 1. 定義を書き出す ---

Write-Host '--- 定義を書き出す ---'
& node (Join-Path $root 'tools/20_build/export-options.mjs') --out $optionsJson
if ($LASTEXITCODE -ne 0) { throw '定義の書き出しに失敗しました' }

# --- 2. csc を探す ---

$csc = 'C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (-not (Test-Path $csc)) {
	# 32bit 版に落とす
	$csc = 'C:/Windows/Microsoft.NET/Framework/v4.0.30319/csc.exe'
}
if (-not (Test-Path $csc)) {
	throw "csc が見つかりません。.NET Framework 4.x が入っているか確認してください。"
}
Write-Host ''
Write-Host "--- コンパイル（$(Split-Path $csc -Leaf)） ---"

# --- 3. コンパイル ---

$sources = @(Get-ChildItem -LiteralPath $srcDir -Filter '*.cs' -File | Sort-Object Name | ForEach-Object { $_.FullName })
if ($sources.Count -eq 0) { throw "ソースがありません: $srcDir" }
Write-Host ("  ソース {0} 本: {1}" -f $sources.Count, (($sources | Split-Path -Leaf) -join ' '))

<#
	/resource: で JSON を埋め込む。exe 1 本で完結させ、
	定義ファイルを一緒に配らなくて済むようにする。

	/nologo    版の表示を出さない
	/optimize  最適化する
	/warnaserror- 警告で止めない（未使用の変数などで作業が止まると煩わしい）
#>
$cscArgs = @(
	'/nologo'
	'/optimize+'
	'/warnaserror-'
	'/target:exe'
	"/out:$outExe"
	"/resource:$optionsJson,cli-options.json"
) + $sources

& $csc @cscArgs
if ($LASTEXITCODE -ne 0) { throw 'コンパイルに失敗しました' }

$size = [int]((Get-Item -LiteralPath $outExe).Length / 1024)
Write-Host ''
Write-Host "=== できました: $($outExe.Replace($root, '.')) （$size KB） ==="

# --- 4. 確かめる ---

if ($Check) {
	Write-Host ''
	Write-Host '--- 動かして確かめる ---'
	& $outExe --help
	if ($LASTEXITCODE -ne 0) { throw "--help が終了コード $LASTEXITCODE で終わりました" }
	Write-Host ''
	Write-Host '=== 確認できました ==='
}
