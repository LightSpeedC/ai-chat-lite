@echo off
rem 画面のテストを通しで回す（テスト用サーバーの起動と停止を含む）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-ui-tests.ps1" %*
pause