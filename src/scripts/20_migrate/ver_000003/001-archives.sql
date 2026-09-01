-- 版 3: archives テーブル
--
-- 1 回の片付けを 1 行として記録する。片付けたものは、その行の番号を指す。
-- messages / cursors / connectors の archived_seq は版 1 で既に置いてある
-- （後から足すとテーブルを作り直すことになるため、先に置いた）。
--
-- 消すのではなく archive にしてあるのは、まとめて戻せるようにするため。
-- deleted_at を各テーブルに持つ案もあったが、それでは「同じ操作で片付けたもの」を
-- 束ねられない。同じルームを 2 回片付けたときに区別もできない。
--
-- msg_kind の CHECK に archive と notice を足すのは版 2 で済んでいる。
-- この版はテーブルを 1 つ足すだけなので、作り直しは要らない。
--
-- 当て済みの環境では二度と実行されない。書き換えてはいけない
-- （指紋が食い違い、起動が止まる）。

-- archive_kind と archive_id は description とは別に持つ。
--
-- description は自由記述で、--description で書き換えられる。書き換えると
-- 「何を片付けたか」が本文から消えるため、対象は列として別に持つ。
--
-- archive_id を TEXT にしているのは、3 種の対象を 1 列で持つため。
-- 発言のときは msg_seq を文字列にして入れる。
CREATE TABLE archives (
  archived_seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  archived_at           TEXT    NOT NULL
                          CHECK (length(archived_at) = 23),
  archived_connector_id TEXT    NOT NULL
                          CHECK (length(archived_connector_id) BETWEEN 1 AND 64),
  archive_kind          TEXT    NOT NULL
                          CHECK (archive_kind IN ('message', 'connector', 'room')),
  archive_id            TEXT    NOT NULL
                          CHECK (length(archive_id) BETWEEN 1 AND 64),
  description           TEXT    NOT NULL
                          CHECK (length(description) BETWEEN 1 AND 200)
);

-- 片付けたものを絞り込む索引。
--
-- 読み出しは archived_seq IS NULL で絞る。生きているものだけを返すため、
-- この条件がほぼすべての読み出しに付く。
CREATE INDEX messages_ix_archived_seq ON messages(archived_seq);
CREATE INDEX cursors_ix_archived_seq ON cursors(archived_seq);
CREATE INDEX connectors_ix_archived_seq ON connectors(archived_seq);
