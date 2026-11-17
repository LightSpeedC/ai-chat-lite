-- 版 9: messages を作り直し、msg_id を NOT NULL・形の CHECK・UNIQUE にする (i261110-03、44-A)
--
-- ALTER では、あとから NOT NULL にも形の CHECK にも変えられない。版 2 と同じく、新しい定義の
-- 別名の表を作り、写し、元を消して名前を変える。定義は sqlite_master から取り出した今の
-- messages (版 2・4・5・8 の結果) に、msg_id の定義を足したもの。手で書き写していない。
--
-- 守るもの: msg_seq の値 (cursors.msg_seq・acked_seq、archived_seq、reply_to_msg_seq が指す)、
-- 採番 (sqlite_sequence)、索引 3 本。msg_id の一意は列の UNIQUE が受け持つ。
--
-- 当て済みの環境では二度と実行されない。書き換えてはいけない。

CREATE TABLE messages_new (
  msg_seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id           TEXT    NOT NULL DEFAULT 'public'
                      CHECK (length(room_id) BETWEEN 1 AND 64),
  sent_at           TEXT    NOT NULL
                      CHECK (length(sent_at) = 23),
  from_connector_id TEXT    NOT NULL
                      CHECK (length(from_connector_id) BETWEEN 1 AND 64),
  msg_kind          TEXT    NOT NULL
                      CHECK (msg_kind IN ('say','join','leave','archive','notice')),
  to_connector_id   TEXT
                      CHECK (to_connector_id IS NULL
                             OR length(to_connector_id) BETWEEN 1 AND 64),
  msg_body          TEXT    NOT NULL
                      CHECK (length(msg_body) BETWEEN 1 AND 32000),
  archived_seq      INTEGER,
  ref_archived_seq  INTEGER,
  reply_to_msg_seq  INTEGER,
  msg_id            TEXT    NOT NULL UNIQUE
                      CHECK (length(msg_id) >= 9
                             AND msg_id GLOB 'm[0-9][0-9][0-9][0-9][0-9][0-9]-[0-9a-km-z][0-9a-km-z]*'
                             AND msg_id NOT GLOB '*[^0-9a-km-z-]*')
) STRICT;

-- msg_id が NULL の行があれば、ここで NOT NULL に弾かれて版ごと失敗する
INSERT INTO messages_new
  (msg_seq, room_id, sent_at, from_connector_id, msg_kind, to_connector_id, msg_body,
   archived_seq, ref_archived_seq, reply_to_msg_seq, msg_id)
SELECT
  msg_seq, room_id, sent_at, from_connector_id, msg_kind, to_connector_id, msg_body,
  archived_seq, ref_archived_seq, reply_to_msg_seq, msg_id
FROM messages;

-- 採番を写す。messages_new 側の行を作り直し、元の seq を持たせる
DELETE FROM sqlite_sequence WHERE name = 'messages_new';
INSERT INTO sqlite_sequence (name, seq)
SELECT 'messages_new', seq FROM sqlite_sequence WHERE name = 'messages';

-- 写し損ねを、黙って残さない。違えば CHECK で版ごと失敗する
CREATE TEMP TABLE msg_copy_check (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO msg_copy_check
SELECT (SELECT COUNT(*) FROM messages) = (SELECT COUNT(*) FROM messages_new)
   AND COALESCE((SELECT MAX(msg_seq) FROM messages), 0) = COALESCE((SELECT MAX(msg_seq) FROM messages_new), 0);
DROP TABLE msg_copy_check;

DROP TABLE messages;
ALTER TABLE messages_new RENAME TO messages;

-- 索引は表と一緒に消えるので張り直す (msg_id の一意は列の UNIQUE)
CREATE INDEX messages_ix_room_id_msg_seq ON messages(room_id, msg_seq);
CREATE INDEX messages_ix_archived_seq ON messages(archived_seq);
CREATE INDEX messages_ix_room_id_sent_at ON messages(room_id, sent_at);
