---
schema: 1
id: i261124-01
title: shutdown と restart に --yes を必須にし、確認文言を厳しくする
group: チャットの機能
created: 2026-11-24
---

restart も shutdown も誤って実行されると全プロジェクトの待受けが切断・影響を受ける。そのため、安易な実行を防ぐよう両コマンドとも `--yes` を必須とし、付けずに実行した場合は再起動・停止の危険性を強く警告し、ユーザーの承認（--yes）を求める厳しいメッセージを出して拒否する。

## やること
- [済] 課題と設計を整理し、chat-review に設計レビューを依頼する
- [済] options.mjs で restart に --yes フラグを定義する
- [済] node 版 (chat.mjs) で restart・shutdown の --yes 検査と厳しい警告文を実装する
- [済] Rust 版 (src/cli-rs) で restart・shutdown の --yes 検査と厳しい警告文を実装する
- [済] 突き合わせテスト (compare-cli / cli-rs.test.mjs) にテストケースを追加する
- [済] ソース変更を chat-review にコードレビュー依頼する
- [済] テストを全件実行して通過を確認する
- [済] build-aichat-rs と install-aichat を実行して反映する
- [済] 利用者による動作検証が完了した (close)
