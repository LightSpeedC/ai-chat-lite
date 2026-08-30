#Requires -Version 5.1
<#
.SYNOPSIS
	区分を分ける前のバックアップを新しい置き場へ移す。

.DESCRIPTION
	_backup 直下にあるものを _backup\hourly\ へ移す。取った間隔が
	まちまちなので、最も細かい区分に入れる。8 本を超える分は
	次のバックアップのときに整理される。

	そのうえで、いちばん新しい 1 本を daily / weekly / monthly にも
	コピーする。そうしないと 3 つの区分が空のまま始まる。monthly に
	1 本目が入るのは翌月 1 日で、それまで戻せる先が hourly しかない
	状態が続く。

	コピーした 3 本は中身が同じだが構わない。日が経てば区分ごとに
	別のものへ置き換わる。

	1 度だけ実行すればよい。2 度目以降は移すものが無いと知らせて終わる。

.EXAMPLE
	.\migrate-backup-layout.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$root      = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$backupDir = Join-Path $root '_backup'

if (-not (Test-Path $backupDir)) {
	Write-Host "バックアップの置き場がまだありません: $backupDir"
	return
}

# --- 1. 直下にあるものを hourly へ移す ---

$loose = @(Get-ChildItem -LiteralPath $backupDir -Filter 'chat-*.db.zip' -File)
$hourlyDir = Join-Path $backupDir 'hourly'

if ($loose.Count -eq 0) {
	Write-Host '直下に移すものはありません。'
} else {
	if (-not (Test-Path $hourlyDir)) {
		New-Item -ItemType Directory -Path $hourlyDir | Out-Null
	}
	Write-Host ('[1/2] {0} 件を hourly へ移します' -f $loose.Count)
	foreach ($f in $loose) {
		$dest = Join-Path $hourlyDir $f.Name
		if (Test-Path $dest) {
			# 同じ名前が既にある。中身も同じはずなので、移さずに置いていく
			Write-Host ('  すでにある: {0}' -f $f.Name)
			continue
		}
		Move-Item -LiteralPath $f.FullName -Destination $dest
		Write-Host ('  移動: {0}' -f $f.Name)
	}
}

# --- 2. 空の区分に最新の 1 本を配る ---

$newest = Get-ChildItem -LiteralPath $hourlyDir -Filter 'chat-*.db.zip' -File -ErrorAction SilentlyContinue |
	Sort-Object Name -Descending | Select-Object -First 1

if (-not $newest) {
	Write-Host ''
	Write-Host '配れるバックアップがありません。backup.ps1 を 1 度実行してください。'
	return
}

Write-Host ''
Write-Host ('[2/2] 最新の {0} を空の区分へ配ります' -f $newest.Name)

foreach ($kind in 'daily', 'weekly', 'monthly') {
	$dir = Join-Path $backupDir $kind
	if (-not (Test-Path $dir)) {
		New-Item -ItemType Directory -Path $dir | Out-Null
	}
	$existing = @(Get-ChildItem -LiteralPath $dir -Filter 'chat-*.db.zip' -File)
	if ($existing.Count -gt 0) {
		Write-Host ('  {0,-8} すでに {1} 件あるので何もしません' -f $kind, $existing.Count)
		continue
	}
	Copy-Item -LiteralPath $newest.FullName -Destination (Join-Path $dir $newest.Name)
	Write-Host ('  {0,-8} 配りました' -f $kind)
}

Write-Host ''
Write-Host '完了しました。'
foreach ($kind in 'hourly', 'daily', 'weekly', 'monthly') {
	$dir = Join-Path $backupDir $kind
	$n = @(Get-ChildItem -LiteralPath $dir -Filter 'chat-*.db.zip' -File -ErrorAction SilentlyContinue).Count
	Write-Host ('  {0,-8} {1} 件' -f $kind, $n)
}
