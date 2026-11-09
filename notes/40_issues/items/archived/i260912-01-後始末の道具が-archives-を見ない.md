---
schema: 1
id: i260912-01
title: 後始末の道具が archives を見ない
group: 開発環境・記録
created: 2026-09-12
---

`tools/40_test/purge-test-data.mjs` が相手にするのは `messages` ・ `cursors` ・ `connectors` の 3 つだけ。**`archives` は対象外**だった。

> [!CAUTION]
> <strong>片付けた記録だけが本番に残り続ける。</strong>本番に入り込んだ `test-` の参加者を `archive` で片付けると、`archives` に「何を片付けたか」の行が残る。**この道具を実行しても、その行は消えない。**
> 実際に 5 件が残っていた。`archives` の説明は `aichat archives` の一覧に出るので、**テストの痕跡が読める状態**だった。

<strong>片付けの知らせ (`msg_kind = archive`)も残る。</strong>差出人は片付けを実行した側なので、`from_connector_id LIKE 'test-%'` には当たらない。本文に対象の名前が出るため、**読めば何を片付けたかが分かる**。

- [済] **本番に残っていた分は手で消した**(23 行。`messages` 11 ・ `connectors` 4 ・ `cursors` 3 ・ `archives` 5)。控えを取り、1 トランザクションで消し、宙に浮いた参照が 0 件であることを実測した
- [済] <strong>道具に `archives` を足した。</strong>対象が `test-` / `sandbox-` の行と、それを指す知らせも消す
- [済] `tests/purge-test-data.test.mjs` に検査を足した

> [!IMPORTANT]
> **見落としは `cursors` にもあった。**`connectors` に行を持たない `test-` の参加者と、`sandbox-` のルームの位置が残っていた。**`who` にも画面にも出ないので、目で見て気づくことはできない。**
