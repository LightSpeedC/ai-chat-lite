-- 版 6: recent の絞り込み（--since / --before）のための索引
--
-- messages はいま (room_id, msg_seq) の複合索引しか持たない。日時で絞る
-- 条件（sent_at >= ? / sent_at < ?）にはこの索引が効かない。
--
-- sent_at は yyyy/mm/dd HH:MM:SS.mmm 固定 23 文字（版 5 で / 区切りに
-- 統一済み）なので、文字列比較がそのまま時系列比較になる。
--
-- 索引を足すだけなので ALTER TABLE も作り直しも要らない。既存行への
-- 影響は無く、CREATE INDEX 自体もいまの件数ならほぼ一瞬で終わる。
--
-- 当て済みの環境では二度と実行されない。書き換えてはいけない
-- （指紋が食い違い、起動が止まる）。

CREATE INDEX IF NOT EXISTS messages_ix_room_id_sent_at ON messages(room_id, sent_at);
