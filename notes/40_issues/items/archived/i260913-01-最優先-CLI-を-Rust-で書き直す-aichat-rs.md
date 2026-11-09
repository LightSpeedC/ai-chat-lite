---
schema: 1
id: i260913-01
title: 【最優先】CLI を Rust で書き直す (aichat-rs.exe)
group: 開発環境・記録
created: 2026-09-13
---

> [!NOTE]
> **当時、最優先の課題として他の未着手より先に進めた。**

<strong>Mac ・ Linux へ展開すると決めたため、C# 版は土俵を降りた。</strong>残る選択肢は TypeScript (node ・ bun)と Rust の 2 系統になる。Rust 版を製品として立てる。

### なぜ Rust か

| 実装 | 待受け中の実メモリ | 確保量 |
|---|---:|---:|
| **Rust (最小の待受け)** | **4.89 MB** | **0.84 MB** |
| bun | 25.59 MB | 108.43 MB |
| node | 58.24 MB | 62.44 MB |

待受けは 1 プロジェクトにつき 1 本、12 時間張りっぱなしになる。<strong>常駐するものなので、ここが効く。</strong>数値の出どころは[CLI 実装のベンチマーク](../../../01_research/r260912-01-CLI実装のベンチマーク.md)。

> [!CAUTION]
> <strong>上の 4.89 MB は待受けしか持たない 111 行の最小実装で測った値である。</strong>検証も表示も持たない。<strong>全機能を入れれば増える。</strong>どこまで増えるかは作ってから測る。

### 作るもの

| 項目 | 中身 |
|---|---|
| 置き場 | `src/cli-rs/`。ビルド出力は `aichat-rs.exe` |
| 範囲 | <strong>全部。</strong>14 コマンド (`join` `wait` `say` `recent` `who` `waiters` `dump` `leave` `archive` `archives` `restore` `rename` `restart` `stop`)と 22 オプション。検証も含める |
| 外部クレート | <strong>使わない。</strong>C# 版が `Json.cs` を自前で持つのと同じ。JSON も HTTP も標準ライブラリだけで書く |
| 定義の出どころ | `src/client/options.mjs` のまま。`export-options.mjs` が書き出す JSON を埋め込む。**手で写さない** |
| 進め方 | <strong>TDD。</strong>落ちるテストを見てから実装する |
| 突き合わせ | `tests/cli-rs.test.mjs` で node 版と出力・終了コードを比べる (`cli-cs.test.mjs` と同じ形) |

> [!NOTE]
> <strong>当時、CLI は一時的に 3 本になった。</strong>Rust 版が動いた後、C# 版は [i260918-01](#i260918-01) で削除し、現在は 2 本である。

### やること

| 状態 | 中身 |
|---|---|
| **☑** | **計画書を立てた。**[CLI を Rust で書く](../../../10_plan/p260913-01-CLIをRustで書く.md) |
| **☑** | <strong>土台 (JSON ・ JST ・ 引数 ・ 定義の読み取り)を TDD で作った。</strong>暦の計算も自前になった (`json.rs` 440 行 ・ `jst.rs` 221 行) |
| **☑** | <strong>日時の解析 (`--since` ・ `--before`)と待受けの選別を移した。</strong>正規表現を使わずに書いた |
| **☑** | <strong>HTTP と 14 コマンドを実装した。</strong>Rust 側の単体テストは 182 件 |
| **☑** | **node 版との突き合わせを通した。**`tests/cli-rs.test.mjs` が繋がない 16 通り、`tools/40_test/compare-cli.mjs` が実サーバーへ繋ぐ 54 通り |
| **☑** | <strong>待受け中のメモリを測り直し、資料に反映した。</strong>全 14 コマンドで 6.41 MB (最小実装 4.89 MB から ＋1.5 MB、node 版 54.20 MB の 1/8)。**関連: [i260905-04](../../issues.md#i260905-04)**(待受けが逼迫で刈られる)。この削減も、2026-09-13 のメモリ増設とあわせて発生条件を遠のかせた一因 |
| **☑** | <strong>`waiters` は Windows の API を直に呼ぶ形にした。</strong>PowerShell (523〜673 ms)から **Rust 25 ms ・ bun 64 ms ・ node 112 ms** になり、C# 版 (229 ms)を下回った。`CreateToolhelp32Snapshot` で一覧を取り、`NtQueryInformationProcess` と `ReadProcessMemory` で PEB を辿ってコマンドラインを読む。仕組みは Rust が `std` の `extern`、bun が `bun:ffi`、node が `koffi`。**PEB の並びは公開されていない**ので、失敗したら黙って PowerShell へ落ちる。**C# 版への依存は切れた** |
| **☑** | <strong>PowerShell へ落ちたときの式から、`wait` という並びを外した。</strong>置くと、その PowerShell 自身のコマンドラインが条件に当たり、数えているプロセスが数に入る。`('* wa' + 'it *')` と割って繋ぐ。これまでは `WAITER_PATTERN` と除外 pid の二重の守りで表面化していなかった |
| **→** | C# 版をどうするかは [i260918-01](#i260918-01) へ切り出し、削除した |
| **☑** | 既定の CLI (`aichat` ・ `aichat.cmd` が呼ぶ先)を Rust 版に変える**実装は完了した**(`8dc9af8`)。<strong>「変わったこと」資料への周知は不要と判断した。</strong>CLI としての動き (コマンド・オプション・出力形式・終了コード)は node 版と一致するよう作られ、突き合わせテストで検証済みのため、利用者から見て挙動は変わらない。「変わったこと」資料の既定方針 (動きが変わったものだけ書く。内側の改善は書かない)に従う |
