@echo off
rem CLI 3 実装（C# 版 ・ node 版 ・ bun 版）のベンチマーク。
rem 先に tools\40_test\start-test-server.cmd でテスト用サーバーを立てること。
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0benchmark-cli.ps1" %*
pause
