@echo off
setlocal
rem ai-chat-lite のサービスを停止して登録を解除する。管理者として実行すること。
rem DB（_data）とログ（logs）は残る。
rem 引数に nopause があれば pause しない（ガードの確認で、入力待ちで固まらないようにするため）。
rem 条件を満たさなければ、WinSW を呼ぶ前に終了コード 1 で止まる。

set "PAUSE_ON=1"
if /i "%~1"=="nopause" set "PAUSE_ON="

rem 1. C: ドライブから実行している
if not "%~d0" == "C:" (
	echo C:ドライブで実行してください。実体のフォルダから実行します。
	goto :fail
)

rem 2. WinSW 本体が隣にある
if not exist "%~dp0node-ai-chat-lite-winsw.exe" (
	echo node-ai-chat-lite-winsw.exe が見つかりません。deploy フォルダに置いてください。
	goto :fail
)

rem 3. 管理者として実行している
fltmc >nul 2>&1
if errorlevel 1 (
	echo 管理者として実行してください。
	goto :fail
)

rem 止まっていると stop は失敗するが、解除は続ける
"%~dp0node-ai-chat-lite-winsw.exe" stop
"%~dp0node-ai-chat-lite-winsw.exe" uninstall
if errorlevel 1 goto :fail

if defined PAUSE_ON pause
exit /b 0

:fail
if defined PAUSE_ON pause
exit /b 1
