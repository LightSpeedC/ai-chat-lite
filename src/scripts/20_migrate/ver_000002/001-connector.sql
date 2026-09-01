-- 版 2: user → connector への改名
--
-- 繋いでくるのは「ユーザ」ではなく、繋いできた人か AI である。user_role が
-- ai と human の 2 つを持っていること自体が、user で括れていない証拠だった。
--
-- ALTER TABLE ... RENAME COLUMN で済むものと、テーブルを作り直すものがある。
-- SQLite の ALTER TABLE は列の追加と改名しかできない。CHECK の変更はできない。
--
-- messages は msg_kind の CHECK に notice を足すため作り直す。
-- cursors と users は改名だけなので RENAME で足りる（users はテーブル名も変える）。
--
-- 当て済みの環境では二度と実行されない。書き換えてはいけない。

-- ---------------------------------------------------------------
-- messages: 列の改名と、msg_kind の CHECK に notice を足す
--
-- 作り直しの手順は 4 つ。索引はテーブルと一緒に消えるので張り直す。
-- AUTOINCREMENT の採番は sqlite_sequence に残るため、写したあとも続きから振られる。
-- ---------------------------------------------------------------

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
  archived_seq      INTEGER
);

INSERT INTO messages_new
  (msg_seq, room_id, sent_at, from_connector_id, msg_kind, to_connector_id, msg_body, archived_seq)
SELECT
  msg_seq, room_id, sent_at, from_user_id, msg_kind, to_user_id, msg_body, archived_seq
FROM messages;

DROP TABLE messages;
ALTER TABLE messages_new RENAME TO messages;

CREATE INDEX messages_ix_room_id_msg_seq ON messages(room_id, msg_seq);

-- ---------------------------------------------------------------
-- cursors: 列の改名だけ。主キーは (connector_id, room_id) のまま追随する
-- ---------------------------------------------------------------

ALTER TABLE cursors RENAME COLUMN user_id TO connector_id;

-- ---------------------------------------------------------------
-- users: テーブル名と列名を変える
--
-- RENAME COLUMN は CHECK の中の名前も一緒に書き換わる。
-- ---------------------------------------------------------------

ALTER TABLE users RENAME COLUMN user_id TO connector_id;
ALTER TABLE users RENAME COLUMN user_role TO connector_role;
ALTER TABLE users RENAME TO connectors;
