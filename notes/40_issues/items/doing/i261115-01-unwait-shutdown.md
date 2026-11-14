---
schema: 1
id: i261115-01
title: 待受けを止める unwait を足し、サーバを落とす stop を shutdown に変える
group: チャットの機能
created: 2026-11-15
---

待受けを止めたつもりで、サーバを落とす aichat stop を思い浮かべる取り違えを防ぐ。決定は 35-A (stop を shutdown に変え --yes を要る)・36-A (aichat unwait を足す)・37-A (-r が完全に一致した待受けだけを止める)。古い名前の stop は何も実行せず unwait だけを案内する。unwait は waiters のように、止めた・止めていない・残っているを表で出し、全部止まらなければ正常終了にしない。

## やること
- [未] 試験を先に書き ❌Red を確かめる
- [未] options.mjs に shutdown・unwait を定義し、stop を案内だけにする
- [未] node 版に実装する
- [未] Rust 版に実装し compare-cli で突き合わせる
- [未] stop を呼ぶ道具・資料を直し CHAT-USAGE・設計書を最新にする
- [未] 全件の試験を流す
- [未] Rust 版を作り直す (既定への写しは指示を待つ)。共通ルールの周知案を出す
