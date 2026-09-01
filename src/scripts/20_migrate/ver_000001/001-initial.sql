-- 版 1: 改名前の形
--
-- すでに動いていた DB はこの形になっている。その場合は当てずに記録するだけ
-- （src/server/migrate.mjs が判断する）。空の DB からは、これを当ててから
-- 版 2（connector への改名）を当てると最新の形になる。
--
-- 当て済みの環境では二度と実行されない。書き換えてはいけない
-- （指紋が食い違い、起動が止まる）。

CREATE TABLE IF NOT EXISTS messages (
  msg_seq      INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id      TEXT    NOT NULL DEFAULT 'public'
                 CHECK (length(room_id) BETWEEN 1 AND 64),
  sent_at      TEXT    NOT NULL
                 CHECK (length(sent_at) = 23),
  from_user_id TEXT    NOT NULL
                 CHECK (length(from_user_id) BETWEEN 1 AND 64),
  msg_kind     TEXT    NOT NULL
                 CHECK (msg_kind IN ('say','join','leave','archive')),
  to_user_id   TEXT
                 CHECK (to_user_id IS NULL
                        OR length(to_user_id) BETWEEN 1 AND 64),
  msg_body     TEXT    NOT NULL
                 CHECK (length(msg_body) BETWEEN 1 AND 32000),
  archived_seq INTEGER
);

CREATE INDEX IF NOT EXISTS messages_ix_room_id_msg_seq ON messages(room_id, msg_seq);

-- どこまで読んだか。参加者とルームの組ごとに 1 行。
-- クライアント側のファイルに置くと、実行した場所に縛られて位置を見失う。
-- サーバーが覚えておけば、どこから繋いでも続きから受け取れる。
CREATE TABLE IF NOT EXISTS cursors (
  user_id      TEXT    NOT NULL
                 CHECK (length(user_id) BETWEEN 1 AND 64),
  room_id      TEXT    NOT NULL
                 CHECK (length(room_id) BETWEEN 1 AND 64),
  msg_seq      INTEGER NOT NULL
                 CHECK (msg_seq >= 0),
  updated_at   TEXT    NOT NULL
                 CHECK (length(updated_at) = 23),
  archived_seq INTEGER,
  PRIMARY KEY (user_id, room_id)
);

CREATE TABLE IF NOT EXISTS users (
  user_id                 TEXT    PRIMARY KEY
                            CHECK (length(user_id) BETWEEN 1 AND 64),
  user_role               TEXT    NOT NULL
                            CHECK (user_role IN ('ai','human')),
  first_joined_at         TEXT    NOT NULL
                            CHECK (length(first_joined_at) = 23),
  last_active_at          TEXT    NOT NULL
                            CHECK (length(last_active_at) = 23),
  active_connection_count INTEGER NOT NULL DEFAULT 0
                            CHECK (active_connection_count >= 0),
  archived_seq            INTEGER
);
