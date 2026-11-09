---
schema: 1
id: i260924-06
title: CHAT-USAGE.html の aichat-node 案内が i260922-01 の判断と食い違う
group: チャットの機能
created: 2026-09-24
---

**定期レビュー (chat #1088)で指摘され、実測で確認した。**[i260922-01](../../issues.md#i260922-01) は「公開インターフェースは `aichat.exe` だけ。`aichat-*.cmd` は開発・突き合わせ用で、他プロジェクトのセッションが名前で呼ぶものではないため対象外」としている。一方 `CHAT-USAGE.html` は他プロジェクト向けに `aichat-node` を名前で呼ぶよう案内し、これも PATH に入っているのでパスは書かない、としている。[i260922-01](../../issues.md#i260922-01) に残る「未」の項目 (PATH からプロジェクトルート自体を外す)を実施すると、この案内は動かなくなる。

あわせて、ルート直下のランチャーは `aichat-bun`(拡張子なし)・`aichat-bun.cmd`・`aichat-node.cmd` の 3 本で、`aichat-node` には拡張子なしの版が無く、Bash からは解決できない (実測で確認済み)。

<strong>選んだ案 (4-A): `aichat-node` を `bin/` へ移す。</strong>フォールバック用の CLI という役割を残したまま、[i260922-01](../../issues.md#i260922-01) の「公開インターフェースは `bin/` だけに置く」に揃えた。

- [済] `bin/aichat-node`(拡張子なし・Bash 用)・`bin/aichat-node.cmd`(PowerShell/cmd 用)を新設し、両方とも実機で動作確認した
- [済] ルート直下の `aichat-node.cmd` を削除した
- [済] 設計書 (`p260829-01-設計.html`)のフォルダ構成を更新した
- [済] `aichat-rs.exe` のビルド出力先も root へ移した (当初は `dist/`)。その直後 (chat #1136)に共通ルール「プロジェクトフォルダ構成」へ「`dist/` は Node/TypeScript 前提の値で、他言語では言語ごとの既定出力先に読み替える (Rust なら `target/` 等)」という注記が加わったため、`dist/` から `target/` へ置き直した。ビルド・配置・全テスト (launchers・exe-swap・cli-rs・archive-exit)で実機確認済み
