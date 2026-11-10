---
schema: 1
id: i261007-02
title: 共通ルールの新しい DB・SQLite の決まり (chat #1377)に追随する
group: データ
created: 2026-10-07
---

`20260905-windows-pc-memory-inspection` から周知 (chat #1377)。共通ルール「SQLite の大原則」に**常駐プロセスの WAL の上限と掃除**が足され、「DB 定義のルール」が新設された。実測で、当プロジェクトに当たるものを分けた。

### 1. 常駐サーバーの WAL (いま当たる)

共通ルールは、開くときに `PRAGMA journal_size_limit` で統合のあとに残す大きさの上限を決め、毎日などの区切りで `PRAGMA wal_checkpoint(TRUNCATE)` を実行して `-wal` を 0 に縮め、**戻り値の先頭が 0 でなければ失敗として記録する**(本処理は止めない。掃除の待ちは短くする)と定める。`src/server/store.mjs` は `PRAGMA journal_mode = WAL` だけで、どちらも無い。<strong>いまの `chat.db-wal` は約 4 MB (2026-10-07 実測)で、自動の統合が効いている範囲。</strong>開いたままの読み取り (閲覧ツールの放置等)があると、統合が進まず大きくなり続ける恐れがある。

### 2. DB 定義のルール (定義・変更するときに当たる)

適用条件は「テーブル・列・索引を**定義・変更するとき**」で、既存の定義を遡って直すものではない。ただし次に版を足すときに従う。`src/scripts/20_migrate/ver_*` の SQL を見た (2026-10-07)ところ、<strong>日時は `_at` の列で `CHECK (length(…) = 23)` つき、連番は `_seq`、版ごとのフォルダと `versions` テーブル (指紋つき)もすでに沿っている。</strong>差として確かめたのは `STRICT` を付けていないことだけで、列名・NULL の扱い・索引名などの細かい点は洗い出していない。

- [済] WAL の上限 (`journal_size_limit`)と、日次の `wal_checkpoint(TRUNCATE)`(失敗の記録つき)を足す。落ちるテストを先に書く
- [済] 「DB 定義のルール」と現行の定義 (日時の形・列名・`STRICT`・NULL の扱い)の差を洗い出す (差は `STRICT` だけとは限らない)。`sqlite_master` から取り出して見る。直すかどうかは、版を足すときの判断とする

### 3. 洗い出した差 (2026-11-11、本番の `sqlite_master` を読み取りだけで取り出した)

テーブルは 6 つ (archives ・ connectors ・ cursors ・ messages ・ versions)、索引は 5 本。

| 決まり | 合っている | 差 |
|---|---|---|
| 日時 (`_at`、23 文字の CHECK) | すべての日時の列 (8 本) | なし |
| `STRICT` | — | **6 テーブルとも付いていない** |
| 略語を使わない | — | `msg_seq` ・ `msg_kind` ・ `msg_body` ・ `reply_to_msg_seq` の `msg`、`ref_archived_seq` の `ref` |
| 主キーは `<テーブル名>_id`、連番は `_seq` | connectors (`connector_id`) | messages は `msg_seq`、archives は `archived_seq`、versions は `version_seq` (連番なので `_seq` は合うが、テーブル名と語が揃っていない) |
| 外部キーの列名は参照先の主キーと同じ | `messages.archived_seq` ・ `connectors.archived_seq` ・ `cursors.archived_seq`、`cursors.connector_id` | `from_connector_id` ・ `to_connector_id` ・ `archived_connector_id` (役割を前に付けている)、`cursors.msg_seq` ・ `acked_seq` ・ `reply_to_msg_seq` ・ `ref_archived_seq` (宣言した外部キーは無く、名前だけで参照している) |
| NULL を許す列に理由のコメント | `ref_archived_seq` (ver_000004)・`reply_to_msg_seq` (ver_000005) | `archived_seq` (3 テーブル)・`to_connector_id`・`acked_seq` は、理由のコメントを確かめていない (未確認) |
| 長さと取りうる値を CHECK で縛る | 文字列の ID ・ 本文 ・ 種別 | `acked_seq` ・ `archived_seq` ・ `ref_archived_seq` ・ `reply_to_msg_seq` に範囲の CHECK が無い。`versions.script` に長さの CHECK が無い |
| 索引の名前 `<テーブル>_ix_<列>_<列>` | 5 本とも | なし |
| テーブル名の単数・複数を揃える | 6 つとも複数 | なし |

直すには、`STRICT` と CHECK はテーブルの作り直し、名前は列の改名 (API ・ CLI 2 本 ・ 試験に及ぶ)が要る。**この課題の取り決めどおり、直すかどうかは次に版を足すときに決める。**
