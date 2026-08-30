@echo off
rem テストが残したデータ（test- の参加者と sandbox- のルーム）を消す
cd /d "%~dp0..\.."
node tools\40_test\purge-test-data.mjs %*
pause