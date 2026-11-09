---
schema: 1
id: i260830-04
title: PlayWright 側の spec をコミットする
group: 開発環境・記録
created: 2026-08-30
---

PlayWright 共有環境の `projects/ai-chat-lite/` の spec が未コミットだった。共有環境の規約では「テストスクリプトは必ず commit する」となっている。別リポジトリなので、こちらのコミットには含まれない。

spec 9 本を 3 回に分けてコミットした。`.gitignore` に `projects/*/tmp/` と `projects/*/test-results/` があり、出力は入っていない。

- [済] `contrast` / `shot` / `chat-ui` / `issues-shot` をコミットする
- [済] 出力 (`tmp/`・`test-results/`)が除外されていることを確かめる
- [済] テストデータの規約に合わせ、`test-data.ts` を足して 4 本を寄せる
- [済] 落ちていた 6 件を直す (決め打ちをやめ、全 54 件が通る状態にした)
