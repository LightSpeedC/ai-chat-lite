@echo off
rem 2 ‚Â‚Ì CLI ‚Ì‹N“®‚Ì‘¬‚³‚ğ‘ª‚éB
rem ˆø”‚Í‚»‚Ì‚Ü‚Ü“n‚éB—á: measure-cli-startup.cmd -Times 50
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0measure-cli-startup.ps1" %*
pause
