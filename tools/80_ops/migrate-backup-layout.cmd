@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0migrate-backup-layout.ps1"
pause
