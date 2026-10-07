@echo off
setlocal
rem ai-chat-lite をサービスとして登録して開始する。管理者として実行すること。
rem X: のような subst の仮想ドライブから実行しないこと。サービスから見えず、登録先に記録されると起動に失敗する。
rem 引数に nopause があれば pause しない（ガードの確認で、入力待ちで固まらないようにするため）。
rem 条件を満たさなければ、WinSW を呼ぶ前に終了コード 1 で止まる。

set "PAUSE_ON=1"
if /i "%~1"=="nopause" set "PAUSE_ON="

rem 1. C: ドライブから実行している
if not "%~d0" == "C:" (
	echo C:ドライブで実行してください。実体のフォルダから実行します。
	goto :fail
)

rem 2. 必要なファイルが隣にある
for %%F in (node-ai-chat-lite-winsw.exe node-ai-chat-lite-winsw.xml node-ai-chat-lite.exe) do (
	if not exist "%~dp0%%F" (
		echo %%F が見つかりません。deploy フォルダに置いてください。
		goto :fail
	)
)

rem 3. すでに登録されていない（古い登録先のまま入れ直すのを防ぐ）
sc query node-ai-chat-lite >nul 2>&1
if not errorlevel 1 (
	echo すでに登録されています。先に uninstall-service.cmd を実行してください。
	goto :fail
)

rem 4. 管理者として実行している
fltmc >nul 2>&1
if errorlevel 1 (
	echo 管理者として実行してください。
	goto :fail
)

"%~dp0node-ai-chat-lite-winsw.exe" install
if errorlevel 1 goto :fail
"%~dp0node-ai-chat-lite-winsw.exe" start
if errorlevel 1 goto :fail

rem 登録された実行ファイルのパスを表示する。C: の実体のパスになっていることを目で確かめる。
echo.
echo 登録されたパス:
sc qc node-ai-chat-lite | findstr BINARY_PATH_NAME

if defined PAUSE_ON pause
exit /b 0

:fail
if defined PAUSE_ON pause
exit /b 1
