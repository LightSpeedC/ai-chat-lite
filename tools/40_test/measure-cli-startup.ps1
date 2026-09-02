#Requires -Version 7
<#
	2 つの CLI の起動の速さを測る。

	  aichat.exe --help
	  node src/client/chat.mjs --help

	【測り方の決めごと】
	  ウォームアップを捨てる    1 回目はファイルキャッシュが冷たい
	  最小値と中央値を見る      平均は外れ値に引っ張られる。最小値がその環境の素の速さに近い
	  出力はリダイレクトで捨てる  | Out-Null はパイプライン処理が乗り、起動時間が埋もれる
	  順序を入れ替えて 2 巡する  先に測った方が有利／不利にならないかを見る
	  素の起動も測る            node -e "" と比べて、module 読み込みの分を切り分ける

	  measure-cli-startup.ps1              既定（20 回 / ウォームアップ 3 回）
	  measure-cli-startup.ps1 -Times 50    回数を変える
#>
param(
	# 測る回数（ウォームアップを除く）
	[int] $Times = 20,

	# 捨てる回数
	[int] $Warmup = 3
)

$ErrorActionPreference = 'Stop'

$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$exe = Join-Path $root 'aichat.exe'
$client = Join-Path $root 'src/client/chat.mjs'
$null = New-Item -ItemType Directory -Force (Join-Path $root 'tmp')
$sink = Join-Path $root 'tmp/measure-sink.txt'

if (-not (Test-Path $exe)) { throw "aichat.exe がありません。tools/20_build/build-aichat.cmd で作ってください。" }

<#
	1 つのコマンドを Times 回測り、ミリ秒の配列を返す。

	出力はファイルへリダイレクトして捨てる。画面に出すと描画の時間が混ざる。
#>
function Measure-Startup {
	param([string] $Label, [scriptblock] $Run)

	for ($i = 0; $i -lt $Warmup; $i++) { & $Run | Out-File -LiteralPath $sink -Encoding utf8 }

	$times = foreach ($i in 1..$Times) {
		(Measure-Command { & $Run | Out-File -LiteralPath $sink -Encoding utf8 }).TotalMilliseconds
	}
	return ,@($times)
}

<# 最小・中央・平均・最大をまとめる #>
function Summarize {
	param([string] $Label, [double[]] $Times)

	$sorted = $Times | Sort-Object
	$mid = [int]($sorted.Count / 2)
	$median = if ($sorted.Count % 2 -eq 0) { ($sorted[$mid - 1] + $sorted[$mid]) / 2 } else { $sorted[$mid] }

	[PSCustomObject]@{
		対象   = $Label
		最小   = [math]::Round($sorted[0], 1)
		中央   = [math]::Round($median, 1)
		平均   = [math]::Round(($Times | Measure-Object -Average).Average, 1)
		最大   = [math]::Round($sorted[-1], 1)
	}
}

Write-Host "=== 起動の速さを測る（$Times 回 / ウォームアップ $Warmup 回） ==="
Write-Host ''

$targets = [ordered]@{
	'aichat.exe --help' = { & $exe --help }
	'node chat.mjs --help' = { & node $client --help }
	'node -e ""（素の起動）' = { & node -e '' }
}

# 1 巡目
Write-Host '--- 1 巡目（この順で測る） ---'
$first = foreach ($name in $targets.Keys) {
	Write-Host "  $name"
	Summarize $name (Measure-Startup $name $targets[$name])
}
$first | Format-Table -AutoSize

# 2 巡目（順序を逆にする）
Write-Host '--- 2 巡目（順序を逆にする） ---'
$reversed = @($targets.Keys) | Sort-Object -Descending
$second = foreach ($name in $reversed) {
	Write-Host "  $name"
	Summarize $name (Measure-Startup $name $targets[$name])
}
$second | Format-Table -AutoSize

# --- まとめ ---

$exeMin = ($first + $second | Where-Object { $_.対象 -eq 'aichat.exe --help' } | Measure-Object -Property 最小 -Minimum).Minimum
$nodeMin = ($first + $second | Where-Object { $_.対象 -eq 'node chat.mjs --help' } | Measure-Object -Property 最小 -Minimum).Minimum
$bareMin = ($first + $second | Where-Object { $_.対象 -like 'node -e*' } | Measure-Object -Property 最小 -Minimum).Minimum

Write-Host '=== まとめ（2 巡の最小値どうしを比べる） ==='
Write-Host ("  aichat.exe          {0,7:N1} ms" -f $exeMin)
Write-Host ("  node chat.mjs       {0,7:N1} ms" -f $nodeMin)
Write-Host ("  node -e ''          {0,7:N1} ms  ← Node 自体の起動" -f $bareMin)
Write-Host ''
Write-Host ("  差（chat.mjs - exe） {0,7:N1} ms" -f ($nodeMin - $exeMin))
Write-Host ("  うち module の読み込み {0,7:N1} ms" -f ($nodeMin - $bareMin))

Remove-Item -LiteralPath $sink -ErrorAction SilentlyContinue
