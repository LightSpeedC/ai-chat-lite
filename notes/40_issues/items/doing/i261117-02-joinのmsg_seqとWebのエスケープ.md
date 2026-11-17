---
schema: 1
id: i261117-02
title: join の出力の msg_seq と、Web の msg_id のエスケープ (P1・P2)
group: チャットの機能
created: 2026-11-17
refs: i261110-03
---

chat-review の指摘 P1: join の出力 (chat.mjs の 563・849-850 行付近) に msg_seq の裸の数が出ていて、--reply-to に写すと別の発言を指す取り違えが起きる。P2: Web (chat.js の 123 行付近) が msg_id をエスケープせずに HTML へ入れている。今ある動き: join の出力のほかの項目と、発言の見出しの msg_id の表示は変えない。

## やること
- [済] P2: Web の msg_id と返信先の選択子をエスケープする (chat.js)
- [未] P1: join と wait の出力の msg_seq (現在位置 N) をどうするか、利用者に確認する (影響: wait の出力・tests 4 本・Rust 版・CHAT-USAGE)
