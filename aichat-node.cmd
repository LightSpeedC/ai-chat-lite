@echo off
rem node 版の CLI を呼ぶ。aichat.exe が使えないときの代替。
rem 実行時にパスを書かなくて済むよう、root に置いて PATH から呼ぶ。
rem 例: aichat-node wait -c <自分の ID> -p 8787
node "%~dp0src/client/chat.mjs" %*
