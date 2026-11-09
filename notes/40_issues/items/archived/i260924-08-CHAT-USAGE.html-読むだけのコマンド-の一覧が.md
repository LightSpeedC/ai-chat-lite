---
schema: 1
id: i260924-08
title: CHAT-USAGE.html 「読むだけのコマンド」の一覧が 2 か所で食い違う
group: チャットの機能
created: 2026-09-24
---

**定期レビュー (chat #1088)で指摘され、実測で確認した。**「読むだけのコマンドは ID を取らない」の節は `who`・`recent`・`dump`・`archives` の 4 つを挙げるが、別の節は `recent`・`who`・`dump` の 3 つしか挙げていない (`archives` が抜けている)。実測では `archives` は名乗る ID 無しで通った (終了コード 0)。

- [済] 抜けている側に `archives` を足した
