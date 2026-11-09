---
schema: 1
id: i260924-05
title: CHAT-USAGE.html が実在しない build-aichat.cmd を案内している
group: チャットの機能
created: 2026-09-24
---

**定期レビュー (chat #1088)で指摘され、実測で確認した。**`CHAT-USAGE.html`「aichat が使えないとき」に `tools/20_build/build-aichat.cmd` を実行して `aichat.exe` を作る手順があり、`csc` は同梱なので追加の導入は要らないと書かれている。実際の `tools/20_build/` にあるのは `build-aichat-rs.mjs`・`export-options.mjs`・`install-aichat.mjs`・`place-exe.mjs` の 4 本で、`build-aichat.cmd` は無い。[i260918-01](#i260918-01)(C# 版の削除)への追随漏れと見ている。

- [済] ローカルルール 3 節「ビルドの順序」 (`build-aichat-rs.mjs` → `install-aichat.mjs`)に合わせて案内を書き直した
