---
schema: 1
id: i260912-02
title: node の fetch は Windows で 1 往復ごとに 15 ms 遅い
group: 開発環境・記録
created: 2026-09-12
---

ローカルの HTTP を 200 往復して測ったところ、**node の `fetch` だけが 15 ms 前後に張り付いた**。同じ node の `http.request` は 0.18 ms で、85 倍の開きがある。

| 手段 | 中央値 | 最小 | p95 |
|---|---:|---:|---:|
| node の `fetch` | 15.21 ms | 0.36 ms | 20.28 ms |
| node の `http.request` | 0.18 ms | 0.14 ms | 0.31 ms |
| bun の `fetch` | 0.09 ms | 0.07 ms | 0.21 ms |

<strong>最小は 0.36 ms まで下がる。</strong>速く返せないのではなく、たいてい 15 ms 待たされている。**Windows の既定のタイマー解像度 (15.6 ms)と一致する。**

### どこに効くか

CLI は `src/client/chat.mjs` の 1 か所で `fetch` を呼んでおり、**API を叩くコマンドはすべてここを通る**(`say` ・ `who` ・ `waiters` ・ `recent` ・ `restart`)。

| 使い方 | 効き方 |
|---|---|
| 待受け (`wait`) | 効かない。long-poll は 1 往復が 240 秒なので 15 ms は埋もれる |
| `say` ・ `recent` | 1 往復ぶん乗る。起動 43.6 ms に足して 15 ms |
| bun で動かしたとき | 乗らない。`aichat` ・ `aichat.cmd` は `bun run` で呼んでいる |

> [!IMPORTANT]
> <strong>この 15 ms は、測る側にも乗る。</strong>サーバーのベンチマークを node で走らせたとき、`say` も `recent` も件数を変えても一律 15 ms になり、**サーバーの性能差がまったく見えなくなった**。クライアントを bun に替えて測り直して初めて、node と bun の差が出た。<br> **ローカルの往復を node の `fetch` で測ってはいけない。**

### やること

- [済] <strong>ベンチマークの側を `http.request` に替えた。</strong>測る側が 15 ms を載せていては、サーバーの差が見えない
- [済] **CLI (`src/client/chat.mjs`)を `http.request` に替えた (案 A)。**`httpJson` を 1 つ置き、`call` と版チェックの 2 か所をそこへ通した
- [未] <strong>Mac ・ Linux で再現するか確かめる。</strong>タイマー解像度が理由なら出ないはずだが、確かめていない。直したので困りはしないが、**同じ穴が他にもあるかの手がかりになる**

### 選べる道

| 案 | 中身 | 引き換えるもの |
|---|---|---|
| **A (採った)** | `fetch` をやめ、`node:http` の `http.request` で書く | 1 か所で済むが、`fetch` より記述が増える。bun でも同じ速さで動く |
| B | node で動かすことを諦め、bun を既定にする | node しか無い環境で遅いまま。CLI を 2 系統で保つ方針とぶつかる |
| C | 何もしない | 人が待つぶんには 15 ms は気づかない。ただし測るたびに踏む |

再現の手順は `tests/http-client-latency.test.mjs` に置いた。測り方と数値は[サーバーのベンチマーク](../../../01_research/r260912-02-サーバーのベンチマーク.md)にある。

> [!TIP]
> <strong>keepAlive の Agent は持たせなかった。</strong>CLI は数回叩いて終わるので、ソケットが開いたまま残るとプロセスが終わらない。**繋ぎ直す分は localhost で 0.1 ms ほどで、消した 15 ms に比べれば無視できる。**
