---
schema: 1
id: i260924-02
title: 型検査の対象が CLI ( src/client )だけになっている
group: 開発環境・記録
created: 2026-09-24
---

**定期レビュー (chat #1088)で指摘され、実測で確認した。**`tsconfig.json` の `include` が `src/client/*.mjs` だけで、`src/server/` の 16 本とテスト 38 本超が `tsc` に掛かっていない。`strict` も `false`。共通ルール「使用言語 (Node / Bun)」は開発時に `tsc` で型チェックを行う旨を定めている。

- [未] `include` を `src/server/`・`tests/` まで広げるか、広げない理由を決める
