---
schema: 1
id: i260909-04
title: waiters の -r が文字種を検証せず、不正な値が素通りする
group: チャットの機能
created: 2026-09-09
---

共通ルール「ai-chat-lite (AI 間チャット)の利用」に `-r 'public,ai-chat-lite'`(シングルクォート)という誤った例が残っていたのを直す過程で見つかった。実際にシングルクォートで囲んで `cmd` から渡すと、`cmd` はクォート文字を値に含めてしまい (`'public,ai-chat-lite'` という壊れた値になる)、これを実際にサーバーへ繋ぐ `recent` 等で渡すと **400 で正しく拒否される**。

しかし **`waiters` だけは違った。**`waiters` はサーバーに繋がないコマンドで、`roomsFrom`(node 版)・`RoomsFrom`(C# 版)が `-r` の値をカンマで分割するだけで、文字種の検証を一切していなかった。サーバー側の `room_id` 検証 (英数字・ハイフン・下線・ピリオドのみ)を経由できないため、`'public,ai-chat-lite'` がエラーにならず `["'public", "ai-chat-lite'"]` という、シングルクォートの断片を含んだ 2 つの「ルーム名」としてそのまま扱われていた。

- [済] `basisOf()`(node 版)・`BasisOf()`(C# 版)で、`roomsFrom` / `RoomsFrom` の結果を `ID_PATTERN` / `Definition.IdPattern` で検証し、不一致なら終了コード 2 で止める形にした
- [済] `tests/client-waiters.test.mjs`・`tests/cli-cs.test.mjs` にテストを追加。**直す前に戻して実際に落ちることを確認してから (RED)、直して通ることを確認した (GREEN)**。両 CLI とも確認済み。全 470 件が通る
