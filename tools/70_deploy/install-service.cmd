@echo off
if not "%~d0" == "C:" (echo C:ドライブで実行してください。& pause & exit 1)
rem ai-chat-lite をサービスとして登録して開始する。管理者として実行すること。
rem N: ドライブから実行しないこと（subst の仮想ドライブはサービスから見えない）。
"%~dp0..\..\node-ai-chat-lite-winsw.exe" install
"%~dp0..\..\node-ai-chat-lite-winsw.exe" start
pause