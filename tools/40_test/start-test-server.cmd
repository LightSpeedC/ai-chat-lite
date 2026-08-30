@echo off
rem テスト用サーバーを別ポート・別DBで立てる（本番は止めない）
cd /d "%~dp0..\.."
node tools\40_test\start-test-server.mjs
pause