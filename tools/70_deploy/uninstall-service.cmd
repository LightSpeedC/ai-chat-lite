@echo off
if not "%~d0" == "C:" (echo C:ドライブで実行してください。& pause & exit 1)
rem ai-chat-lite のサービスを停止して登録を解除する。管理者として実行すること。
rem DB（_data）とログ（logs）は残る。
"%~dp0..\..\node-ai-chat-lite-winsw.exe" stop
"%~dp0..\..\node-ai-chat-lite-winsw.exe" uninstall
pause