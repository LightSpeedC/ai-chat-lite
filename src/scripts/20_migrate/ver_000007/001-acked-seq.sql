-- 版 7: 配信済み位置と確定済み位置を分ける（i260917-01）
--
-- msg_seq は「wait が応答を返した時点で走査末尾まで進む」配信済み位置のまま
-- 使う。acked_seq を新設し、こちらを「確定済み位置」とする。
--
-- 既存行は acked_seq = msg_seq（＝今ある分は確定済み扱い）で初期化する。
-- こうしないと、移行直後の最初の poll でいきなり大量の pending が
-- 返ってしまう（今まで配信済みだった分がすべて未確定に見えてしまうため）。

ALTER TABLE cursors ADD COLUMN acked_seq INTEGER;

UPDATE cursors SET acked_seq = msg_seq WHERE acked_seq IS NULL;
