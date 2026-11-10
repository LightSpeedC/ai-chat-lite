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
- [未] 「DB 定義のルール」と現行の定義 (日時の形・列名・`STRICT`・NULL の扱い)の差を洗い出す (差は `STRICT` だけとは限らない)。`sqlite_master` から取り出して見る。直すかどうかは、版を足すときの判断とする
