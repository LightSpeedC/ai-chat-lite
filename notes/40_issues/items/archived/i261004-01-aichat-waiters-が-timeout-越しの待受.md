---
schema: 1
id: i261004-01
title: aichat waiters が timeout 越しの待受けを 2 本と数える (ルーム名が public' に壊れる)
group: チャットの機能
created: 2026-10-04
---

**ai-agent-support から報告があり (chat #1346)、実機で再現した。**`timeout 7200 aichat wait :id: -p 8787 -r public` を `run_in_background` で起動すると、同じ ID が `aichat` と `bash`(ルーム `public'`)の 2 行で出る。`timeout` を付けない他プロジェクトの待受けは 1 本のままで、報告の「自分の ID だけ」は当たっている。

### 原因 (実測)

親子の連なりは `aichat.exe`(4992)→ `timeout.exe`(43092)→ `timeout.exe`(26352)で、**外側の `timeout.exe` の親 (8296)がすでに終了している**。ハーネスが起こした `bash.exe`(38572、コマンドラインに `aichat wait :id: …` をそのまま持つ)から `timeout` へ親子がつながらない。`pickWaiters` は「当たったものの直親を落とす」ので、つながらない `bash` は直子を持たない末端として残り、2 本目になる。`public'` は `bash -c "…"` の引用符が `-r public` の直後に付いたもの。

> [!IMPORTANT]
> <strong>node 版 (`chat.mjs` の `pickWaiters`)と Rust 版 (`waiters.rs`)の両方に同じ作りがある。</strong>どちらかだけ直すと、突き合わせテスト (`tests/cli-rs.test.mjs`・`tools/40_test/compare-cli.mjs`)が食い違いを落とす。

### 直し方 (4-A で決定)

**末端に数えるのを、待受けの実体 (`aichat`・`aichat-rs`・`node`・`bun`)だけにした。**`bash`・`timeout`・`pwsh` 等のラッパーは、親子がどうつながっていても数えない。ラッパーは親の判定と張り方の判定 (`cmd.exe` 越しの `node` は `aichat-node`)には使い続ける。実体の名前が増えたら `WAITER_RUNTIMES`(node 版)・`is_waiter_runtime`(Rust 版)へ足す。足し忘れても本数が少なく見えるだけで、二重に数えて「張らなくてよい」と読み違える向きには外れない。

**テストの写しも解消した。**`tests/client-waiters.test.mjs` は `pickWaiters` と `targetOf` を自分の中に写して検査していた (本体を壊しても緑のまま)。選び方を `waiters-pick.mjs` へ出して、`chat.mjs` とテストが同じ実物を使う形にした。

- [済] 落ちるテストを先に書いた (node 版 2 件・Rust 版 2 件が「1 本が 2 本に見えている」「ラッパーを待受けと数えている」で落ちることを確かめた)
- [済] node 版・Rust 版の両方を直した。node の `client-waiters` 55 件・Rust 197 件が合格。`bin/aichat.exe` へ写し、実機の `aichat waiters` で `ai-agent-support` が 1 本になった (`bash`・`public'` の行が消えた)
- [済] ai-agent-support へ原因を返信した (chat #1348)。直したことの返信は、commit・push のあとに送る
- [済] ai-agent-support に、手元で `aichat waiters` が 1 本になるか確認してもらった。1 本 (張り方 `aichat`)のみで、`bash`・`public'` の行は出なかった (chat #1355、2026-10-05)。確認が取れたので「済」にした
