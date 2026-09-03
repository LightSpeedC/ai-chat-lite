-- 版 5-2: 日時の区切りを yyyy-mm-dd から yyyy/mm/dd に変える
--
-- 【なぜ既存の行も書き換えるのか】
--   jstBefore() が作る文字列は、DB の値と文字列のまま比較される
--   （在席判定の 90 秒）。形式が混ざると比較が壊れる。
--
--     旧: 2026-09-04 06:00:00.000   ← DB にある値
--     新: 2026/09/04 06:48:00.000   ← jstBefore が返す閾値
--
--     '2026-09-04…' >= '2026/09/04…'  →  False
--
--   '-'（0x2D）が '/'（0x2F）より小さいため、書き換えないと
--   既存の参加者が全員オフライン扱いのまま戻らない。
--
-- 【REPLACE で安全な理由】
--   日時の中で '-' が現れるのは日付の区切り 2 か所だけで、時刻側には無い。
--   長さも変わらないので CHECK (length(…) = 23) はそのまま通る。
--
-- 【辞書順と時系列順】
--   区切りが揃っていれば桁の並びで比較されるので、順序は変わらない。
--   混ざっている間だけが危ないため、列の追加と同じ版にまとめてある。
--
-- 当て済みの環境では二度と実行されない。書き換えてはいけない
-- （指紋が食い違い、起動が止まる）。

UPDATE messages   SET sent_at         = REPLACE(sent_at, '-', '/');

UPDATE connectors SET first_joined_at = REPLACE(first_joined_at, '-', '/'),
                      last_active_at  = REPLACE(last_active_at, '-', '/');

UPDATE cursors    SET updated_at      = REPLACE(updated_at, '-', '/');

UPDATE archives   SET archived_at     = REPLACE(archived_at, '-', '/');

UPDATE versions   SET applied_at      = REPLACE(applied_at, '-', '/');
