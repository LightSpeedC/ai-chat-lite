# tests/ 配下のテストを 1 本ずつ実行する。
# 依存パッケージは使わず、Node 標準のテストランナー (node --test) で回す。
#
# 1 本ごとに時間の上限を付ける。超えたら子孫ごと止めて時間切れとし、次へ進む。
# 試験が残したプロセスも、1 本終わるたびに止める (共通ルール「試験には時間の上限を付ける」)。
# Start-Process -Wait は使わない。残ったプロセスの終了まで待ち、一括実行が止まるため。

param(
	[string]$Path = (Join-Path $PSScriptRoot '../../tests'),
	[int]$TimeoutSec = 300
)

$ErrorActionPreference = 'Stop'
$testDir = (Resolve-Path -LiteralPath $Path).Path
$tmpDir = Join-Path $PSScriptRoot '../../tmp'
New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null

$testFiles = @(Get-ChildItem -LiteralPath $testDir -Filter '*.test.mjs' -File | Sort-Object Name)
if ($testFiles.Count -eq 0) {
	Write-Output "試験が見つかりません: $testDir"
	exit 2
}

# 試験のプロセスをジョブに入れる。子孫は同じジョブに入るので、親が先に終わって残った子も
# ジョブから辿れる。taskkill /T は親が居ないと辿れず、起動時刻で探すと他プロジェクトの分まで止める
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TestJob {
	[DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr a, string n);
	[DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
	[DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr job, uint code);
	[DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
	[DllImport("kernel32.dll")] static extern bool QueryInformationJobObject(IntPtr job, int cls, out ACCOUNTING info, int len, IntPtr ret);
	[StructLayout(LayoutKind.Sequential)] struct ACCOUNTING {
		public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
		public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
	}
	public static IntPtr Create(IntPtr proc) {
		IntPtr job = CreateJobObject(IntPtr.Zero, null);
		if (job == IntPtr.Zero || !AssignProcessToJobObject(job, proc)) throw new Exception("ジョブに入れられません: " + Marshal.GetLastWin32Error());
		return job;
	}
	// まだ動いているプロセスの数
	public static int Active(IntPtr job) {
		ACCOUNTING info;
		if (!QueryInformationJobObject(job, 1, out info, Marshal.SizeOf(typeof(ACCOUNTING)), IntPtr.Zero)) return -1;
		return (int)info.ActiveProcesses;
	}
	public static void Kill(IntPtr job) { TerminateJobObject(job, 1); CloseHandle(job); }
}
'@

Write-Output "=== ai-chat-lite テスト ==="
Write-Output "対象: $testDir ($($testFiles.Count) 本、1 本の上限 $TimeoutSec 秒)"
Write-Output ''

$passCount = 0
$failCount = 0
$timeoutCount = 0
foreach ($testFile in $testFiles) {
	$outFile = Join-Path $tmpDir "run-tests-$PID-out.txt"
	$errFile = Join-Path $tmpDir "run-tests-$PID-err.txt"
	$startedAt = Get-Date
	$testProc = Start-Process -FilePath 'node' -ArgumentList @('--test', "`"$($testFile.FullName)`"") `
		-PassThru -NoNewWindow -RedirectStandardOutput $outFile -RedirectStandardError $errFile
	# Handle に触れないと、終わったあとの ExitCode が空になる
	$job = [TestJob]::Create($testProc.Handle)
	$finished = $testProc.WaitForExit($TimeoutSec * 1000)
	$leftCount = [TestJob]::Active($job)
	if ($finished -and $leftCount -lt 0) { $leftCount = 0 }
	# 時間切れなら試験の本体とその子も数に入っているので、残したプロセスとしては数えない
	if (-not $finished) { $leftCount = 0 }
	[TestJob]::Kill($job)
	$testProc.WaitForExit()
	$elapsed = [int]((Get-Date) - $startedAt).TotalSeconds

	if (-not $finished) {
		$timeoutCount++
		Write-Output ("⏱️ 時間切れ {0} ({1} 秒で止めました)" -f $testFile.Name, $elapsed)
	} elseif ($testProc.ExitCode -eq 0) {
		$passCount++
		Write-Output ("✅ 合格 {0} ({1} 秒)" -f $testFile.Name, $elapsed)
	} else {
		$failCount++
		Write-Output ("❌ 不合格 {0} ({1} 秒、終了コード {2})" -f $testFile.Name, $elapsed, $testProc.ExitCode)
		[System.IO.File]::ReadAllLines($outFile) | Where-Object { $_ -match '^\s*✖' } | Select-Object -Unique | ForEach-Object { "    $($_.Trim())" }
	}
	if ($leftCount -gt 0) {
		Write-Output ("  ⚠️ 試験が残したプロセス {0} 本を止めました" -f $leftCount)
	}
	Remove-Item -LiteralPath $outFile, $errFile -ErrorAction SilentlyContinue
}

Write-Output ''
Write-Output ("合格 {0} 本 / 不合格 {1} 本 / 時間切れ {2} 本" -f $passCount, $failCount, $timeoutCount)
if ($failCount -eq 0 -and $timeoutCount -eq 0) {
	Write-Output 'すべて通りました'
	exit 0
}
exit 1
