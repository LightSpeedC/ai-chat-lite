#Requires -Version 5.1
<#
.SYNOPSIS
	バックアップのタスクを 4 つ登録する。

.DESCRIPTION
	管理者権限は要らない。ログオンしているユーザーのタスクとして登録する。

	  hourly    毎時 0 分        8 世代
	  daily     毎日 0 時 1 分   7 世代
	  weekly    月曜 0 時 2 分   4 世代
	  monthly   1 日 0 時 3 分   6 世代

	1 つのタスクを毎時動かして「いまどの区分か」を判定する作りにはしない。
	時刻で判定すると、PC が寝ていて時刻を過ぎた回を取りこぼす。タスク
	スケジューラの StartWhenAvailable は区分ごとに独立して取り返すため、
	そちらに任せる。

	時刻を 1 分ずつずらしてある。同時刻にすると 4 つが同じ DB を同時に読み、
	ファイル名の秒まで一致して衝突する。

	サービス（node-ai-chat-lite）とは別に動く。バックアップは読み取り専用の
	接続で行うため、サーバーが動いていても構わない。

	タスクは \ai-chat-lite\ フォルダに作る。ルート直下には置かない。
	Windows の既定のタスクに紛れると見分けがつかなくなるため。
	フォルダは登録のときに自動で作られる。

.PARAMETER TaskFolder
	タスクを置くフォルダ。既定は \ai-chat-lite\。

.PARAMETER Unregister
	登録を解除する。

.EXAMPLE
	.\register-backup-tasks.ps1
	.\register-backup-tasks.ps1 -Unregister
	.\register-backup-tasks.ps1 -TaskFolder '\自分の道具\ai-chat-lite\'
#>
[CmdletBinding()]
param(
	[string] $TaskFolder = '\ai-chat-lite\',
	[switch] $Unregister
)

$ErrorActionPreference = 'Stop'

# 前後をスラッシュで挟んだ形に揃える。この形でないと Get / Unregister が空振りする
if (-not $TaskFolder.StartsWith('\')) { $TaskFolder = '\' + $TaskFolder }
if (-not $TaskFolder.EndsWith('\'))   { $TaskFolder = $TaskFolder + '\' }

$script = Join-Path $PSScriptRoot 'backup.ps1'
$prefix = 'ai-chat-lite バックアップ'

<#
	取る時刻をずらす。月曜 0 時には 4 つすべてが順に走る。

	タスク名に時刻を入れてある。「毎時・毎日・毎週・毎月」だけだと
	一覧が文字コード順に並び、実行順とは無関係な並びになる。
	時刻を先に置けば、名前順がそのまま実行順になる。

	名前では 00:00 ではなく 00時00分 と書く。タスクは
	C:\Windows\System32\Tasks\ の下にタスク名と同じ名前のファイルとして
	保存されるため、ファイル名に使えない文字（: \ / * ? " < > |）は
	名前にできない。: を入れると「パラメーターが間違っています」で
	落ちるが、エラーからは原因が分からない。
#>
$plans = @(
	@{ Kind = 'hourly';  At = '00:00'; Span = '毎時'; Keep = 8; Desc = '毎時 0 分 / 8 世代' }
	@{ Kind = 'daily';   At = '00:01'; Span = '毎日'; Keep = 7; Desc = '毎日 0 時 1 分 / 7 世代' }
	@{ Kind = 'weekly';  At = '00:02'; Span = '毎週'; Keep = 4; Desc = '月曜 0 時 2 分 / 4 世代' }
	@{ Kind = 'monthly'; At = '00:03'; Span = '毎月'; Keep = 6; Desc = '1 日 0 時 3 分 / 6 世代' }
)
foreach ($p in $plans) {
	$hh, $mm = $p.At -split ':'
	$p.Name = '{0} {1}時{2}分 ({3})' -f $prefix, $hh, $mm, $p.Span
}

if ($Unregister) {
	foreach ($p in $plans) {
		# TaskPath を省くと名前が合っていても見つからない
		if (Get-ScheduledTask -TaskName $p.Name -TaskPath $TaskFolder -ErrorAction SilentlyContinue) {
			Unregister-ScheduledTask -TaskName $p.Name -TaskPath $TaskFolder -Confirm:$false
			Write-Host ('解除しました: {0}{1}' -f $TaskFolder, $p.Name)
		} else {
			Write-Host ('登録されていません: {0}{1}' -f $TaskFolder, $p.Name)
		}
	}
	<#
		空になったフォルダを消す。

		Unregister-ScheduledTask はタスクを消すだけでフォルダを残す。
		コマンドレットにフォルダを消す手段が無いため COM を使う。

		中身が残っていれば「ディレクトリが空ではありません」で拒否され、
		中のタスクは無事。人が別のタスクを同じフォルダに入れていた場合も
		巻き添えにしない
	#>
	$leaf = $TaskFolder.Trim('\')
	if ($leaf) {
		try {
			$svc = New-Object -ComObject Schedule.Service
			$svc.Connect()
			$parent = Split-Path ('\' + $leaf) -Parent
			if (-not $parent) { $parent = '\' }
			$svc.GetFolder($parent).DeleteFolder((Split-Path $leaf -Leaf), 0)
			Write-Host ''
			Write-Host ('フォルダ {0} も消しました' -f $TaskFolder)
		} catch {
			# 中身が残っている、もともと無い、など。どちらも困らない
			Write-Host ''
			Write-Host ('フォルダ {0} は残しました（{1}）' -f $TaskFolder, ($_.Exception.Message -replace "`r?`n", ' ').Trim())
		}
	}
	return
}

# 電源とネットワークの条件を外す。ノート PC でバッテリー駆動でも走らせる
$settings = New-ScheduledTaskSettingsSet `
	-StartWhenAvailable `
	-AllowStartIfOnBatteries `
	-DontStopIfGoingOnBatteries `
	-ExecutionTimeLimit (New-TimeSpan -Minutes 10)

<#
	毎月 1 日のトリガだけは XML で作る。

	New-ScheduledTaskTrigger に月次の指定が無く、CIM のクラスを組み立てても
	「パラメーターが間違っています」で受け付けられなかった（プロパティ名を
	MonthOfYear に直しても同じ）。XML なら通る。
#>
$monthlyXml = @'
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>__DESC__</Description>
  </RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>__START__</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByMonth>
        <DaysOfMonth><Day>1</Day></DaysOfMonth>
        <Months>
          <January /><February /><March /><April /><May /><June />
          <July /><August /><September /><October /><November /><December />
        </Months>
      </ScheduleByMonth>
    </CalendarTrigger>
  </Triggers>
  <Settings>
    <StartWhenAvailable>true</StartWhenAvailable>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT10M</ExecutionTimeLimit>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>powershell.exe</Command>
      <Arguments>__ARGS__</Arguments>
    </Exec>
  </Actions>
</Task>
'@

foreach ($p in $plans) {
	$argLine = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -Kind {1}' -f $script, $p.Kind
	$desc    = 'ai-chat-lite の DB を _backup\{0} へ保存する（{1}）' -f $p.Kind, $p.Desc

	if (Get-ScheduledTask -TaskName $p.Name -TaskPath $TaskFolder -ErrorAction SilentlyContinue) {
		Unregister-ScheduledTask -TaskName $p.Name -TaskPath $TaskFolder -Confirm:$false
	}

	# フォルダが無ければ登録のときに作られる。
	# -ErrorAction Stop を付けないと、失敗しても次の行に進んで「登録しました」と出る
	if ($p.Kind -eq 'monthly') {
		# 時刻は $p.At から作る。名前と食い違わないよう 1 箇所で決める
		$hh, $mm = $p.At -split ':'
		$start = (Get-Date -Hour ([int]$hh) -Minute ([int]$mm) -Second 0).ToString('yyyy-MM-ddTHH:mm:ss')

		$xml = $monthlyXml.
			Replace('__DESC__',  [System.Security.SecurityElement]::Escape($desc)).
			Replace('__START__', $start).
			Replace('__ARGS__',  [System.Security.SecurityElement]::Escape($argLine))

		Register-ScheduledTask `
			-TaskName $p.Name `
			-TaskPath $TaskFolder `
			-Xml $xml `
			-ErrorAction Stop | Out-Null
	} else {
		$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argLine

		$trigger = switch ($p.Kind) {
			'hourly' {
				# 毎時。1 日 1 回のトリガに繰り返しを足す形でしか作れない
				$t = New-ScheduledTaskTrigger -Daily -At $p.At
				$t.Repetition = (New-ScheduledTaskTrigger -Once -At $p.At `
					-RepetitionInterval (New-TimeSpan -Hours 1) `
					-RepetitionDuration (New-TimeSpan -Days 1)).Repetition
				$t
			}
			'daily'  { New-ScheduledTaskTrigger -Daily -At $p.At }
			'weekly' { New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At $p.At }
		}

		Register-ScheduledTask `
			-TaskName $p.Name `
			-TaskPath $TaskFolder `
			-Action $action `
			-Trigger $trigger `
			-Settings $settings `
			-Description $desc `
			-ErrorAction Stop | Out-Null
	}

	Write-Host ('登録しました: {0}  {1}' -f $p.Name, $p.Desc)
}

Write-Host ''
Write-Host ('置き場: タスクスケジューラの {0} フォルダ' -f $TaskFolder)
Write-Host ''
Write-Host 'いま試すには:'
Write-Host ("  Start-ScheduledTask -TaskName '{0}' -TaskPath '{1}'" -f $plans[0].Name, $TaskFolder)
Write-Host ''
Write-Host '一覧を見るには:'
Write-Host ("  Get-ScheduledTask -TaskPath '{0}' | Select-Object TaskName, State" -f $TaskFolder)
Write-Host ''
Write-Host '最後に走った結果を見るには:'
Write-Host ("  Get-ScheduledTask -TaskPath '{0}' | Get-ScheduledTaskInfo |" -f $TaskFolder)
Write-Host '    Select-Object TaskName, LastRunTime, LastTaskResult'
