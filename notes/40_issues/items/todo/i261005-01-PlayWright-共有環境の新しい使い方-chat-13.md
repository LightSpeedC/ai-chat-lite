---
schema: 1
id: i261005-01
title: PlayWright 共有環境の新しい使い方 (chat #1359)へ追随する (画面テストが旧方式のまま)
group: 開発環境・記録
created: 2026-10-05
---

`PlayWright` から周知 (chat #1359)。<strong>旧方式 (`projects/` への事前配置、`PW_PROJECT`・`PW_TEST_DIR`・`PW_OUT_DIR`、`npm run test:projects`)は廃止され、動かない。</strong>新しくは `T:/PlayWright/bin` を PATH に通し、呼び出し元のプロジェクトルートから `playwright-test [--test-dir <パス>] [--out-dir <パス>]` で実行する。テストスクリプトは**呼び出し元自身の `tests/` に置く**。Firefox・WebKit も使えるようになった。

### このプロジェクトの現状 (実測)

- 画面テストの spec 9 本 (`chat-ui`・`archives-ui`・`leave-beacon`・`leave-methods`・`reload-leave`・`log-html`・`contrast`・`shot`・`issues-shot`)と `test-data.ts` は、**このリポジトリの外 (PlayWright 側の `projects/ai-chat-lite/`)にある**。リポジトリ内に `.spec.ts` は 0 件。
- `tools/40_test/run-ui-tests.ps1` が `npm run test:projects` を呼ぶ旧方式のままで、**いまは動かない**。
- 旧方式の手順が `notes/30_status/status.html` と `notes/10_plan/p260831-01-テスト環境の分離.html` に書かれている。
- **移行時に当たりうる既知の問題は、PlayWright 側で直った**(他プロジェクトから PlayWright への報告 chat #1360、修正の報告 chat #1363。当プロジェクトでは未確認): `playwright-test` が空白・`|` を含む引数 (`-g "…"`)を cmd で崩す問題と、`tests/` が共有環境の外にあると `@playwright/test` を読めない問題。`NODE_PATH` は要らない。

- [未] spec の置き場を決める (`tests/` 直下は `node --test` の対象と混ざるため、`tests/ui/` 等の分け方と、`node --test` が `.spec.ts` を拾わないことの確認が要る)
- [未] spec 9 本と `test-data.ts` をこのリポジトリへ移す (`contrast.spec.ts` は `check-contrast` と重なるため、要否も決める)
- [未] `run-ui-tests.ps1` を `playwright-test --test-dir … --out-dir …` に書き換える (本番ではなくテスト用サーバーを立てる前後の手順は残す)
- [未] status・計画書 (p260831-01)の旧方式の記述を、実装したものに合わせる
