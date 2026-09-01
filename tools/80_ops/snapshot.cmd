@echo off
rem ß–Ú‚ÌT‚¦‚ğ 1 ‚Âæ‚éBo—Í‚Í _backup\yyyymmdd-hhmmss-<–¼‘O>.db
rem —á: snapshot.cmd ver3
cd /d "%~dp0..\.."
node tools\80_ops\snapshot.mjs %*
pause
