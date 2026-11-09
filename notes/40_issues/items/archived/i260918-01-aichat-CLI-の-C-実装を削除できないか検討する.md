---
schema: 1
id: i260918-01
title: aichat CLI の C# 実装を削除できないか検討する
group: 開発環境・記録
created: 2026-09-18
---

<strong>利用者からの提案。</strong>node (bun)版と Rust 版の 2 実装で突き合わせながら進められている現状から、C# 版はもう不要ではないか、というもの。ローカルルール「CLI を直したら 3 本とも直す」にも元々<strong>「C# 版は対比実装として残している (後で消す)」</strong>と明記されており、削除自体は既定路線だった。

> [!NOTE]
> node-Rust の突き合わせ (`tools/40_test/compare-cli.mjs`、54 通り)は**C# 版を含んでいない**。C# 版は独立したテスト (`tests/cli-cs.test.mjs`、20 件)でのみ検証されており、3 本の相互突き合わせという形にはなっていない。

### 削除した対象

- [済] `src/cli-cs/` 本体一式
- [済] `tests/cli-cs.test.mjs`(20 件)
- [済] `tools/20_build/build-aichat.ps1` ・ `build-aichat.cmd`
- [済] `tools/40_test/benchmark-cli.ps1` ・ `benchmark-waiters.mjs` から C# 版の行を外した
- [済] `.gitignore` のコメントから `aichat-cs` を外した
- [済] ローカルルールを「CLI を直したら 2 本とも直す」に書き換えた
- [済] `notes/10_plan/p260829-01-設計.html` の CLI 本数 (2 本)・ツリー・テスト表を直した
- [済] `notes/30_status/status.html` に削除の記録を足した
- [済] `src/client/proc-list.mjs` ・ `waiters-pick.mjs` ・ `tests/cli-rs.test.mjs` ・ `client-waiters.test.mjs` のコメント中の C# 版言及を、過去形または Rust 版の記述に直した

**過去の計画書 (`p260902-01-CLIを2本持つ.html` 等)とベンチマーク資料 (`r260912-01-CLI実装のベンチマーク.html`)は、実装した経緯の記録としてそのまま残した**(改変していない)。

> [!IMPORTANT]
> **3 本目 (C# 版)を持っていたことで見つかった食い違いが過去に複数あった**(待受け一覧のミリ秒精度、`say` の終了コード等)。node-Rust の 2 本比較だけで、今後も同種の食い違いを見つけられるかは、実績が無いため未知数のまま残る。

> [!CAUTION]
> <strong>後始末忘れがあった (chat #1088 定期レビューの雑談で発覚)。</strong>ビルドスクリプト (`build-aichat.ps1`・`build-aichat.cmd`)は削除したが、**既にビルド済みだった `aichat-cs.exe` 自体を消していなかった**。`*.exe` は `.gitignore` 対象で `git status` に出ないため見落としやすい。「もう作れない」ようにしただけで、「既にある」ものへの後始末が抜けていた。
> あわせて、同じく `.gitignore` 対象で残っていた `aichat-go.exe`(`r260912-01` ベンチマーク調査の副産物。調査は完了済みで、ソース (`tools/40_test/wait-go/main.go`)は資料として残す一方、ビルド済みのバイナリは再現可能なので不要と判断)もあわせて削除した。
> - [済] `aichat-cs.exe`・`aichat-go.exe` を削除した
