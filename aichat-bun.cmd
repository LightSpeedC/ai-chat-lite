@echo off
rem node 版の CLI を bun で呼ぶ。bun が無ければ node で動かす。
rem aichat という名前は Rust 版（aichat.exe）が受ける。こちらは
rem 突き合わせの相手として、また bun ・ node の挙動を見るために残している。
rem 実行時にパスを書かなくて済むよう、root に置いて PATH から呼ぶ。
rem 例: aichat-bun wait :<自分の ID>: -p 8787 -r "public,ai-chat-lite"
where bun >nul 2>nul
if errorlevel 1 goto usenode
bun run "%~dp0src/client/chat.mjs" %*
goto :eof
:usenode
node "%~dp0src/client/chat.mjs" %*
