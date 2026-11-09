---
schema: 1
id: i260909-02
title: connector_id を改名する手段が無い
group: データ
created: 2026-09-09
---

プロジェクト名の変更などで、参加済みの `connector_id` を改名したくなることが**たびたび起きる**。しかし CLI・API のどちらにも改名のコマンドが無い。

改名するには `connectors` ・ `cursors` ・ `messages`(`from_connector_id` ・ `to_connector_id`)・ `archives`(`archived_connector_id`、`archive_kind='connector'` のときは `archive_id` も)を横断して書き換える必要があり、そのたびに手作業で SQL を組み立てて DB を直接触っている。

> [!WARNING]
> <strong>直接 SQL を書く前提が続くと、対象の絞り込み漏れに気づけない。</strong>今回 (`agent-rules` → `ai-agent-rules`)は `to_connector_id` ・ `archives` のどちらも対象が 0 件だったため実害は無かったが、次に改名するときも同じ確認を毎回手で行うことになる。

2026-09-09、`agent-rules` を `ai-agent-rules` に改名した際の実施内容 (`tools/80_ops/snapshot.mjs` で控えを取ってから、3 文を 1 トランザクションで実行)：

```sql
UPDATE connectors SET connector_id = 'ai-agent-rules' WHERE connector_id = 'agent-rules';  -- 1 件
UPDATE cursors     SET connector_id = 'ai-agent-rules' WHERE connector_id = 'agent-rules';  -- 1 件
UPDATE messages    SET from_connector_id = 'ai-agent-rules' WHERE from_connector_id = 'agent-rules';  -- 10 件
```

### 作ったもの

`rename :<自分のID>: connector :<旧>: :<新>:` を新設した。`archive` と同じ形で、**先に件数を出し、旧 ID の入力を求めてから実行する**。

| どこ | 直す列 |
|---|---|
| `connectors` | `connector_id`(主キー)。漏らすと**発言は見えるのに参加者一覧にいない** |
| `cursors` | `connector_id`(複合主キーの一部)。漏らすと**読んだ位置を失い、次の待受けが「今から」になる** |
| `messages` | `from_connector_id` ・ `to_connector_id` ・ **`msg_body` の `@旧ID`**。本文へ自分で `@相手` と書く形も普通に使うため、列だけ直すと過去のやり取りが古い名前で残り、検索も当たらない |
| `archives` | `archived_connector_id`(実行者)と、`archive_kind='connector'` のときの `archive_id`(対象)。漏らすと**片付けの一覧に古い名前が残り、戻す判断ができない** |

> [!IMPORTANT]
> <strong>本文の `@旧ID` は前方一致で置き換えない。</strong>SQL の `REPLACE()` は境界を見ないので、`@project-a` を直すつもりで `@project-aa` まで壊す。ID に使える文字 (`[A-Za-z0-9_.-]`)が続くときは別物として残す。**実測で確かめた**(`@test-rename-demo` は置き換わり、`@test-rename-demo2` は残る)。

> [!CAUTION]
> <strong>待受け (接続)が走っている間は断る。</strong>付け替えても、その待受けは古い ID で `poll` し続け、新しい ID のカーソルを見ない。サーバーは古い ID の位置を進めないので、**届いているつもりで届かない**状態になる。先に止めてもらう。
> <strong>新しい ID が既に使われていれば断る。</strong>片付け済みの参加者も `connectors` に行が残り、主キーの枠を占め続ける (読み出しには出ないので空いて見える)。そこへ付け替えると主キーが衝突する。

- [済] `store.mjs` に `previewRename` ・ `renameConnector` を足した。**4 テーブル 7 か所を 1 つのトランザクションで直す**(途中で失敗したら何も変わらない)
- [済] `GET /api/admin/rename-preview` ・ `POST /api/admin/rename` を足した。`confirm` に旧 ID を求め、既定のルームへ知らせを積む
- [済] node 版 ・ C# 版の両方に実装した ([ローカルルール](../../../90_rules/local-rules.md)「CLI を直したら 2 本とも直す」に従う)。`tests/cli-cs.test.mjs` で下見の出力と中止の終了コードを突き合わせている
- [済] `tests/rename.test.mjs`(11 件)と `server.test.mjs`(5 件)を新設。**いずれも直す前に落ちることを確認してから (RED)、直して通ることを確認した (GREEN)**。全 494 件が通る
- [済] テスト用サーバー (`tmp/_data`)で通しの動作も確かめた。**本番には触れていない**

> [!NOTE]
> **テストの置き方で 1 つ踏んだ。**`cli-cs.test.mjs` はサーバーを同じ Node のプロセスで動かしているため、**同期の `execFileSync` を使うとイベントループが止まり、子プロセスの下見のリクエストに応答できない**(30 秒待って出力が空になった)。確認の入力を渡すときは `spawn` で標準入力に書く。
