<#
	CLI 3 実装のベンチマーク。

	  aichat-cs.exe                C# 版（.NET Framework）
	  node src/client/chat.mjs     node 版
	  bun run src/client/chat.mjs  bun 版（同じソースを bun で動かす）

	【測るもの】
	  1. 待受け中のメモリ（最重要）… wait を起こして、そのプロセスの使用量を見る
	  2. 起動の速さ                … --help を繰り返して最小値・中央値を見る

	【測り方の決めごと】
	  テスト用サーバーへ繋ぐ    本番に参加者が増えないようにする。立っていなければ止める
	  安定してから測る          起動直後は確保の途中で、値が上下する
	  何度かサンプリングする    1 点だけ見ると、たまたまの値を拾う
	  ウォームアップを捨てる    1 回目はファイルキャッシュが冷たい
	  順序を入れ替えて 2 巡する  先に測った方が有利／不利にならないかを見る
	  素の起動も測る            node -e 0 ・ bun -e 0 と比べ、ソースの読み込み分を切り分ける

	結果は tmp/benchmark-cli.json に書く。HTML はそれを見て別に作る。

	  benchmark-cli.ps1                 既定（起動 20 回 / メモリは 10 秒待って 5 回）
	  benchmark-cli.ps1 -Times 50
#>
param(
	# 起動を測る回数（ウォームアップを除く）
	[int] $Times = 20,

	# 捨てる回数
	[int] $Warmup = 3,

	# 待受けが安定するまで待つ秒数
	[int] $SettleSec = 10,

	# メモリを何回サンプリングするか（1 回の起動の中で）
	[int] $Samples = 5,

	# 起動からやり直す回数。1 回の起動だけ見ると、たまたまの値を拾う
	[int] $Repeats = 3
)

$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$exe = Join-Path $root 'aichat-cs.exe'
$rs = Join-Path $root 'aichat-rs.exe'
$go = Join-Path $root 'aichat-go.exe'
$client = Join-Path $root 'src/client/chat.mjs'
$tmp = Join-Path $root 'tmp'
$null = New-Item -ItemType Directory -Force $tmp
$sink = Join-Path $tmp 'benchmark-sink.txt'

if (-not (Test-Path $exe)) { throw "aichat-cs.exe がありません。tools/20_build/build-aichat.cmd で作ってください。" }

<#
	ネイティブコマンドを黙って走らせる。

	CLI は繋ぎ先を毎回 stderr に出す。Windows PowerShell 5.1 は
	$ErrorActionPreference = 'Stop' のとき、ネイティブコマンドが stderr へ
	書いただけで NativeCommandError を投げる。ここだけ緩める
	（restore.ps1 が同じ理由で同じ形にしている）。
#>
function Invoke-Quiet {
	param([string] $File, [string[]] $Arguments)

	$prev = $ErrorActionPreference
	$ErrorActionPreference = 'Continue'
	try {
		& $File @Arguments *> $sink
	} finally {
		$ErrorActionPreference = $prev
	}
}

<#
	繋ぎ先を決める。

	待受けは参加者として登録されるので、本番には繋がない。テスト用サーバーが
	立っていれば、その接続情報（tmp/_data/server.json）から読む。
#>
$info = Join-Path $tmp '_data/server.json'
if (-not (Test-Path $info)) {
	throw "テスト用サーバーが立っていません。tools/40_test/start-test-server.cmd で立ててください。"
}
$server = Get-Content -LiteralPath $info -Raw | ConvertFrom-Json
$port = $server.port
$token = $server.access_token
Write-Host "繋ぎ先: localhost:$port（テスト用）"
Write-Host ''

<#
	比べる実装。起動の仕方だけが違う。

	Rust 版と Go 版は wait だけを持つベンチマーク用の実装で、検証も表示も無い
	（tools/40_test/wait-rs ・ wait-go）。ほかの 3 つは製品の CLI である。
#>
$impls = [ordered]@{
	'C# 版（exe）' = @{ File = $exe; Args = @() }
	'node 版'      = @{ File = 'node'; Args = @($client) }
	'bun 版'       = @{ File = 'bun'; Args = @('run', $client) }
	'Rust 版'      = @{ File = $rs; Args = @() }
	'Go 版'        = @{ File = $go; Args = @() }
}

foreach ($p in @($rs, $go)) {
	if (-not (Test-Path $p)) {
		throw "$p がありません。tools/40_test/wait-rs ・ wait-go でビルドしてください。"
	}
}

# =====================================================================
# 1. 待受け中のメモリ
# =====================================================================

<#
	1 実装ぶんの待受けを起こし、落ち着いてからメモリを測る。

	子プロセスも数える。bun や node が別プロセスを立てる作りなら、
	そちらの分も使用量に含めなければ比べたことにならない。
#>
function Measure-WaitMemory {
	param([string] $Label, [hashtable] $Impl, [string] $ConnectorId)

	$common = @(
		'wait', ":${ConnectorId}:",
		'-p', "$port",
		'-r', 'sandbox-bench',
		'-a', $token
	)

	<#
		先に 1 回走らせて、読んだ位置を立てておく。

		初めての接続は案内を出してすぐ終わる仕様なので（i260909-01）、
		いきなり測ろうとすると待受けに入る前にプロセスが消える。
	#>
	Invoke-Quiet $Impl.File ($Impl.Args + $common + @('--wait-sec', '1'))

	$args = @($Impl.Args) + $common + @('--wait-sec', '600')

	<#
		リダイレクト先は 1 回ごとに別名にする。

		同じ名前を使い回すと、止めた待受けのハンドルが解放される前に次が
		開こうとして「別のプロセスで使用されている」で落ちる。
	#>
	$stamp = [guid]::NewGuid().ToString('N').Substring(0, 8)
	$out = Join-Path $tmp "benchmark-wait-$stamp.txt"

	$proc = Start-Process -FilePath $Impl.File -ArgumentList $args -PassThru -NoNewWindow `
		-RedirectStandardOutput $out -RedirectStandardError "$out.err"

	try {
		Write-Host ("  {0} を起こしました（pid {1}）。{2} 秒待ちます" -f $Label, $proc.Id, $SettleSec)
		Start-Sleep -Seconds $SettleSec

		$ws = @()
		$pb = @()
		$procCount = 0

		for ($i = 0; $i -lt $Samples; $i++) {
			$tree = Get-ProcessTree -RootId $proc.Id
			if ($tree.Count -eq 0) { throw "$Label の待受けが落ちています（出力: $out）" }
			$procCount = $tree.Count
			$ws += ($tree | Measure-Object -Property WorkingSet64 -Sum).Sum
			$pb += ($tree | Measure-Object -Property PrivateMemorySize64 -Sum).Sum
			Start-Sleep -Milliseconds 800
		}

		return [PSCustomObject]@{
			label       = $Label
			pid         = $proc.Id
			processes   = $procCount
			workingSet  = [math]::Round((($ws | Measure-Object -Average).Average) / 1MB, 2)
			privateMem  = [math]::Round((($pb | Measure-Object -Average).Average) / 1MB, 2)
			wsMax       = [math]::Round((($ws | Measure-Object -Maximum).Maximum) / 1MB, 2)
		}
	} finally {
		Stop-ProcessTree -RootId $proc.Id
		# ハンドルが解放されるまで少し待ってから消す
		Start-Sleep -Milliseconds 500
		Remove-Item -LiteralPath $out, "$out.err" -Force -ErrorAction SilentlyContinue
	}
}

<# 自分と子孫のプロセスを集める #>
function Get-ProcessTree {
	param([int] $RootId)

	$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
	$ids = New-Object System.Collections.Generic.List[int]
	$ids.Add($RootId)

	# 幅優先で子をたどる。深さは高々数段なので素朴に回してよい
	$added = $true
	while ($added) {
		$added = $false
		foreach ($p in $all) {
			if ($ids.Contains([int]$p.ParentProcessId) -and -not $ids.Contains([int]$p.ProcessId)) {
				$ids.Add([int]$p.ProcessId)
				$added = $true
			}
		}
	}

	$found = foreach ($id in $ids) {
		Get-Process -Id $id -ErrorAction SilentlyContinue
	}
	return @($found)
}

<# 子から順に止める #>
function Stop-ProcessTree {
	param([int] $RootId)

	$tree = Get-ProcessTree -RootId $RootId
	foreach ($p in ($tree | Sort-Object Id -Descending)) {
		Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
	}
}

Write-Host '=== 1. 待受け中のメモリ ==='
Write-Host ''

$memory = @()
$n = 0
foreach ($label in $impls.Keys) {
	$n++

	# 起動からやり直して、ばらつきを見る
	$runs = foreach ($r in 1..$Repeats) {
		Measure-WaitMemory $label $impls[$label] "test-bench$n"
	}

	$memory += [PSCustomObject]@{
		label      = $label
		processes  = ($runs | Select-Object -First 1).processes
		repeats    = $Repeats
		workingSet = [math]::Round((($runs | Measure-Object -Property workingSet -Average).Average), 2)
		wsMin      = ($runs | Measure-Object -Property workingSet -Minimum).Minimum
		wsMax      = ($runs | Measure-Object -Property wsMax -Maximum).Maximum
		privateMem = [math]::Round((($runs | Measure-Object -Property privateMem -Average).Average), 2)
		pmMin      = ($runs | Measure-Object -Property privateMem -Minimum).Minimum
		pmMax      = ($runs | Measure-Object -Property privateMem -Maximum).Maximum
	}
}

$memory | Format-Table -AutoSize
Write-Host ''

# =====================================================================
# 2. 起動の速さ
# =====================================================================

<# 1 つのコマンドを Times 回測り、ミリ秒の配列を返す #>
function Measure-Startup {
	param([string] $File, [string[]] $Args)

	for ($i = 0; $i -lt $Warmup; $i++) {
		Invoke-Quiet $File $Args
	}
	$times = foreach ($i in 1..$Times) {
		(Measure-Command { Invoke-Quiet $File $Args }).TotalMilliseconds
	}
	return ,@($times)
}

<# 最小・中央・平均・最大をまとめる #>
function Summarize {
	param([string] $Label, [double[]] $Times)

	$sorted = @($Times | Sort-Object)
	$mid = [int]($sorted.Count / 2)
	$median = if ($sorted.Count % 2 -eq 0) { ($sorted[$mid - 1] + $sorted[$mid]) / 2 } else { $sorted[$mid] }

	[PSCustomObject]@{
		label  = $Label
		min    = [math]::Round($sorted[0], 1)
		median = [math]::Round($median, 1)
		avg    = [math]::Round(($Times | Measure-Object -Average).Average, 1)
		max    = [math]::Round($sorted[-1], 1)
	}
}

Write-Host "=== 2. 起動の速さ（$Times 回 / ウォームアップ $Warmup 回） ==="
Write-Host ''

<#
	素の起動も測る。

	空文字列は渡さない。Windows PowerShell 5.1 はネイティブコマンドへ空の
	引数を渡せず、-e だけが届いて即座に落ちる。0 は評価しても何も起きない式。
#>
$startupTargets = [ordered]@{
	'C# 版（exe）'       = @{ File = $exe; Args = @('--help') }
	'node 版'            = @{ File = 'node'; Args = @($client, '--help') }
	'bun 版'             = @{ File = 'bun'; Args = @('run', $client, '--help') }
	'Rust 版'            = @{ File = $rs; Args = @('--help') }
	'Go 版'              = @{ File = $go; Args = @('--help') }
	'node -e 0（素）'    = @{ File = 'node'; Args = @('-e', '0') }
	'bun -e 0（素）'     = @{ File = 'bun'; Args = @('-e', '0') }
}

Write-Host '--- 1 巡目 ---'
$first = foreach ($label in $startupTargets.Keys) {
	Write-Host "  $label"
	Summarize $label (Measure-Startup $startupTargets[$label].File $startupTargets[$label].Args)
}
$first | Format-Table -AutoSize

Write-Host '--- 2 巡目（順序を逆にする） ---'
$reversed = @($startupTargets.Keys) | Sort-Object -Descending
$second = foreach ($label in $reversed) {
	Write-Host "  $label"
	Summarize $label (Measure-Startup $startupTargets[$label].File $startupTargets[$label].Args)
}
$second | Format-Table -AutoSize

# 2 巡のうち小さい方を採る（その環境の素の速さに近い）
$startup = foreach ($label in $startupTargets.Keys) {
	$a = $first | Where-Object { $_.label -eq $label }
	$b = $second | Where-Object { $_.label -eq $label }
	[PSCustomObject]@{
		label  = $label
		min    = [math]::Min($a.min, $b.min)
		median = [math]::Min($a.median, $b.median)
		avg    = [math]::Round((($a.avg + $b.avg) / 2), 1)
		max    = [math]::Max($a.max, $b.max)
	}
}

# =====================================================================
# 3. 書き出し
# =====================================================================

$out = [PSCustomObject]@{
	measuredAt = (Get-Date).ToString('yyyy/MM/dd HH:mm:ss')
	versions   = [PSCustomObject]@{
		node = (& node --version)
		bun  = (& bun --version)
		os   = [System.Environment]::OSVersion.VersionString
	}
	settings   = [PSCustomObject]@{
		times = $Times; warmup = $Warmup; settleSec = $SettleSec; samples = $Samples; repeats = $Repeats
	}
	memory     = $memory
	startup    = @($startup)
	startupFirst = @($first)
	startupSecond = @($second)
}

$jsonPath = Join-Path $tmp 'benchmark-cli.json'
$out | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $jsonPath -Encoding UTF8

Write-Host ''
Write-Host '=== まとめ ==='
$startup | Format-Table -AutoSize
Write-Host ("結果を書きました: {0}" -f ($jsonPath -replace [regex]::Escape($root), '.'))

Remove-Item -LiteralPath $sink, "$sink.err" -ErrorAction SilentlyContinue
