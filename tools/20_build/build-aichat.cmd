@echo off
rem C# 版 CLI（aichat.exe）を作る。出力は root。
rem 引数はそのまま渡る。例: build-aichat.cmd -Check
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-aichat.ps1" %*
pause
