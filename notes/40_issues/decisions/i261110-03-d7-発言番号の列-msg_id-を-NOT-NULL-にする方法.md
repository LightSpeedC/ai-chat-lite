---
schema: 1
id: i261110-03-d7
title: 発言番号の列 msg_id を NOT NULL にする方法
parent: i261110-03
decided: 2026-11-17
chosen: A
legacy_ids: :ai-chat-lite:44-A
---

## 案

- A: 2 つの版に分ける。ver_000008 で NULL 可の列を足して全件を埋め、ver_000009 で表を作り直して NOT NULL・形の CHECK・UNIQUE を付ける
- B: NOT NULL DEFAULT '' で足し、全件を埋め、BEFORE INSERT の引き金で '' を弾く (空文字を無いの印にする)
- C: NULL 可のまま、発言を足す処理と試験で守る (DB は守らない)

2026-11-17 に決定。DB が番号の無い行を弾く。実測 (SQLite 3.54.1): NOT NULL は既定値なしでは足せないが、DEFAULT '' なら足せる。CHECK は足すときに既存行が検査され、'' の行で落ちる。ver_000002 で messages を作り直した前例がある
