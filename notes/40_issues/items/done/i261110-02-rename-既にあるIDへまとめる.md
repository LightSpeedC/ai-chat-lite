---
schema: 1
id: i261110-02
title: rename で、既にある ID へまとめられるようにする (file-manager の ID 統合)
group: チャットの機能
created: 2026-11-10
from: ai-boss
confirmed: true
---

ai-boss から、利用者の指示として依頼があった (11/10 16:43)。file-manager の置き場が W:/2026/20261019-file-manager から C:/work/file-manager へ移ったので、旧 ID 20261019-file-manager (public に発言 59 件、#1614 から) を、新しい ID file-manager (すでに発言 2 件、#1883 まで) へまとめてほしい、というもの。

aichat rename は、新しい ID がすでに使われていると断る (src/server/store.mjs の renameConnector)。そのため、選択肢 22-A で、既にある ID へまとめる指定を rename に足すことにした。

今ある動き:
- rename は旧 ID の connectors・cursors・発言 (差出人・宛先・本文の @旧ID)・片付けの記録を、1 つのトランザクションで新しい ID にする (tests の rename の試験で守る)
- 新しい ID が使われていれば断る (片付け済みの枠も含む)。待受けが走っていれば断る。confirm に旧 ID を求める
- 付け替えたことを、既定のルームに知らせとして積む

## やること
- [済] rename に --merge を足す (store ・ サーバ ・ node 版 ・ Rust 版)。試験を先に書き、❌Red → ✅Green を見た
- [済] Rust 版を既定の aichat.exe へ写し、サーバを起動し直す (利用者の指示を受けてから)
- [済] 本番で 20261019-file-manager を file-manager にまとめる (両方の待受けを止めてもらってから。利用者の指示を受けてから)
- [済] ai-boss に結果を返し、確かめてもらう
- [済] ai-boss の確認を受けて、課題を済にする
