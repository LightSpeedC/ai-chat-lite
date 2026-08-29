# 開発用にサーバーを起動する。
#
# サービスとして常駐させている場合は同じポートを使うため、先に停止すること。
#   node-ai-chat-lite-winsw.exe stop
#
# 終了は Ctrl+C。

$ErrorActionPreference = 'Stop'
$projectRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $projectRoot

Write-Output "=== ai-chat-lite サーバー（開発用） ==="
Write-Output "終了するには Ctrl+C を押してください"
Write-Output ''

node src\server\main.mjs
