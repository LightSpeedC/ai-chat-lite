@echo off
rem テストが残したデータ（test- の参加者と sandbox- のルーム）を消す。
rem 置き場は --test か --production で明示する（付け忘れは断られる）。
rem   例: purge-test-data.cmd --test
rem       purge-test-data.cmd --production --dry-run
cd /d "%~dp0..\.."
node tools\40_test\purge-test-data.mjs %*
pause