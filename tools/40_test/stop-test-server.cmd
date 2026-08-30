@echo off
rem テスト用サーバーを止める
cd /d "%~dp0..\.."
node tools\40_test\start-test-server.mjs --stop
pause