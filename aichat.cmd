@echo off
rem node 版の CLI を bun で呼ぶ。aichat という名前はこれが受ける。
rem C# 版は aichat-cs.exe、node を直に使う形は aichat-node.cmd にある。
rem 実行時にパスを書かなくて済むよう、root に置いて PATH から呼ぶ。
rem 例: aichat wait :<自分の ID>: -p 8787 -r "public,ai-chat-lite"
bun run "%~dp0src/client/chat.mjs" %*
