-- 版 8: 発言番号 msg_id (m{yymmdd}-nn) の列を足し、今ある全行に振る (i261110-03)
--
-- 人に見せる番号を msg_seq (#1234) から m261117-0c の形に変える。msg_seq は内部の並びと
-- 読み位置のために残す。この版では列を NULL 可で足し、全件を埋める。NOT NULL と形の CHECK は、
-- 表を作り直す版 9 で付ける (ALTER では付けられない)。この 2 つは続けて当たる。
--
-- 日付は sent_at の日 (yyyy/mm/dd の 3〜10 字目を yymmdd にする)、日内の連番は msg_seq の順。
-- nn は 35 字 (l を除く) の 2 桁。作り方は src/server/msg-id.mjs の countToNn と同じ式で、
-- 2 桁に収まる (1 日 1,189 件まで)。超える日があれば、一時テーブルの CHECK で版ごと失敗させる。
--
-- 当て済みの環境では二度と実行されない。書き換えてはいけない。

ALTER TABLE messages ADD COLUMN msg_id TEXT;

-- 日ごとの連番の台帳。行を数えて 1 を足す方式は、行が無くなったときに番号が重なる。
-- 台帳は増える一方なので重ならない
CREATE TABLE message_day_counters (
  message_day TEXT    PRIMARY KEY
                CHECK (length(message_day) = 6),
  last_count  INTEGER NOT NULL
                CHECK (last_count >= 0)
) STRICT;

-- 日ごとの何件目か。CHECK が 1,189 件の超過を止める
CREATE TEMP TABLE msg_id_work (
  msg_seq     INTEGER PRIMARY KEY,
  message_day TEXT    NOT NULL,
  rn          INTEGER NOT NULL
                CHECK (rn BETWEEN 1 AND 1189)
);

INSERT INTO msg_id_work (msg_seq, message_day, rn)
SELECT
  msg_seq,
  substr(sent_at, 3, 2) || substr(sent_at, 6, 2) || substr(sent_at, 9, 2),
  ROW_NUMBER() OVER (PARTITION BY substr(sent_at, 1, 10) ORDER BY msg_seq)
FROM messages;

UPDATE messages
SET msg_id = 'm' || w.message_day || '-'
          || substr('0123456789abcdefghijkmnopqrstuvwxyz', w.rn / 35 + 1, 1)
          || substr('0123456789abcdefghijkmnopqrstuvwxyz', w.rn % 35 + 1, 1)
FROM msg_id_work AS w
WHERE messages.msg_seq = w.msg_seq;

-- 起動後の最初の発言が、続きの番号から始まるように
INSERT INTO message_day_counters (message_day, last_count)
SELECT message_day, MAX(rn) FROM msg_id_work GROUP BY message_day;

DROP TABLE msg_id_work;

-- 版 9 で表を作り直すと消える。ここで張るのは、版 8 だけの状態でも重なりを止めるため
CREATE UNIQUE INDEX messages_ix_msg_id ON messages(msg_id);
