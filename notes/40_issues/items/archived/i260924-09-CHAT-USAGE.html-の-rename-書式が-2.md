---
schema: 1
id: i260924-09
title: CHAT-USAGE.html の rename 書式が 2 か所で違う
group: チャットの機能
created: 2026-09-24
---

**定期レビュー (chat #1088)で指摘され、実測で確認した。**`-h` と同じ形 (`rename :<id>: connector :<旧>: :<新>:`)は片方の節だけにあり、もう片方は名乗る `:<id>:` が抜けた形 (`rename connector :<旧>: :<新>:`)になっている。

- [済] 抜けている側に `:<id>:` を足した
