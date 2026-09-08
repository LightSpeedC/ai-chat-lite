<#
	C# 版 CLI（aichat.exe）を作る。

	  1. 動いている待受けが掴んでいる古い exe を退避する
	  2. options.mjs から定義を JSON に書き出す
	  3. csc でコンパイルし、その JSON を埋め込む
	  4. root に aichat.exe を置く

	csc は .NET Framework に同梱されているので、SDK の導入は要らない。
	出力は Git 管理外（.gitignore に書いてある）。作り直せるものを履歴に入れない。

	【なぜ退避するのか】
	  待受け（aichat wait）は 12 時間張りっぱなしになる。その間 exe は掴まれた
	  ままで、上書きも削除もできず、コンパイルが「アクセスが拒否されました」で
	  失敗する。実際にそれで止まった。

	  掴んでいるのは自分の待受けだけではない。他プロジェクトの分も混ざる。
	  止めれば相手は原因不明の exit 255 で落ちるので、止めてはいけない
	  （notes/40_issues の i260901-07）。

	  Windows では、走っている exe は削除できないが名前は変えられる。走っている
	  プロセスは名前を変えたあとの実体を使い続けるため、退避しても落ちない。
	  空いた名前に新しいものを置ける。

	  退避したものは、次のビルドのときに消せるだけ消す。待受けが張り直されて
	  いれば消え、まだ掴まれていれば残る。放っておいて構わない。

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

# --- 1. 掴まれている古い exe を退避する ---

Write-Host '--- 古い exe を片付ける ---'

<#
	前のビルドで退避したものを消す。掴まれていれば消えないので、失敗は無視する。
	消えなかったぶんは次のビルドでまた試す。
#>
$stale = @(Get-ChildItem -LiteralPath (Join-Path $root 'tmp') -Filter 'aichat-old-*.exe' -File -ErrorAction SilentlyContinue)
$removed = 0
foreach ($old in $stale) {
	try {
		Remove-Item -LiteralPath $old.FullName -ErrorAction Stop
		$removed++
	} catch {
		# まだ待受けが掴んでいる。次のビルドで消える
	}
}
if ($stale.Count -gt 0) {
	Write-Host ("  退避済み {0} 本のうち {1} 本を消しました（残り {2} 本は待受けが掴んでいます）" -f
		$stale.Count, $removed, ($stale.Count - $removed))
}

<#
	いまの exe を片付ける。ふつうは消えるが、待受けが掴んでいると消えない。
	そのときは名前を変えて退避する。走っているプロセスは退避先を使い続ける。
#>
if (Test-Path -LiteralPath $outExe) {
	try {
		Remove-Item -LiteralPath $outExe -ErrorAction Stop
		Write-Host '  いまの exe を消しました（誰も掴んでいません）'
	} catch {
		$parked = Join-Path $root ('tmp/aichat-old-{0}.exe' -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
		Move-Item -LiteralPath $outExe -Destination $parked
		Write-Host "  待受けが掴んでいるので退避しました: $($parked.Replace($root, '.'))"
		Write-Host '    走っている待受けは落ちません。退避先を使い続けます'
	}
}

# --- 2. 定義を書き出す ---

Write-Host ''
Write-Host '--- 定義を書き出す ---'
& node (Join-Path $root 'tools/20_build/export-options.mjs') --out $optionsJson
if ($LASTEXITCODE -ne 0) { throw '定義の書き出しに失敗しました' }

# --- 3. csc を探す ---

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

# --- 4. コンパイル ---

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
	# 待受けを数えるのに WMI（Win32_Process）を引く。既定では参照されない
	'/r:System.Management.dll'
	'/target:exe'
	"/out:$outExe"
	"/resource:$optionsJson,cli-options.json"
) + $sources

& $csc @cscArgs
if ($LASTEXITCODE -ne 0) { throw 'コンパイルに失敗しました' }

$size = [int]((Get-Item -LiteralPath $outExe).Length / 1024)
Write-Host ''
Write-Host "=== できました: $($outExe.Replace($root, '.')) （$size KB） ==="

# --- 5. 確かめる ---

if ($Check) {
	Write-Host ''
	Write-Host '--- 動かして確かめる ---'
	& $outExe --help
	if ($LASTEXITCODE -ne 0) { throw "--help が終了コード $LASTEXITCODE で終わりました" }
	Write-Host ''
	Write-Host '=== 確認できました ==='
}
