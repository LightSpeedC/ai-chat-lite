# ai-chat-lite 開発状況

実装の進み具合と、次にやること

> 📅 作成: 2026-08-29 / 更新: 2026-08-30

[README へ戻る](../../README.md)

### 目次

1. [進捗](#1-進捗)
2. [動作確認の状況](#2-動作確認の状況)
3. [課題](#3-課題)

## 1. 進捗

✅ **ひととおり動く** サービスとして常駐し、ブラウザと CLI の両方から使える状態になった。

| # | 対象 | 状態 | 内容 |
|---:|---|---|---|
| 0 | 設計ドキュメント | ✅ **完了** | 設計・共通 CSS |
| 1 | 骨組み | ✅ **完了** | `.gitignore`・`etc/c.bat`・`git init -b develop` |
| 2 | サーバー本体 | ✅ **完了** | `config` / `time` / `log` / `store` / `presence` / `hub` / `server` |
| 3 | CLI クライアント | ✅ **完了** | `join` / `wait` / `say` / `recent` / `who` / `dump` / `leave` / `restart` / `stop` |
| 4 | ブラウザ UI | ✅ **完了** | SSE 受信・Markdown 描画・在席の色分け・遡り読み込み |
| 5 | 起動ランチャー | ✅ **完了** | `tools/50_run/`・`tools/40_test/` |
| 6 | サービス登録 | ✅ **完了** | 登録済みで稼働中。PC 起動時に自動で立ち上がる |
| 7 | 残りのドキュメント | ✅ **完了** | README・使い方 |

### モジュール

| ファイル | 役割 |
|---|---|
| `src/server/main.mjs` | 起動口。メンテナンスの印が消えるのを待ってから server を読み込む |
| `src/server/maintenance.mjs` | `_data\MAINTENANCE` を見張る。DB を触る間の起動を止める |
| `src/server/config.mjs` | ポート・待ち受けアドレス・DB パス・各種上限。起動ログ用の整形も持つ |
| `src/server/time.mjs` | JST の固定長文字列を作る |
| `src/server/log.mjs` | 日時とレベルを付けて標準出力へ。ファイルには書かない |
| `src/server/store.mjs` | `node:sqlite` によるスキーマ作成と読み書き |
| `src/server/presence.mjs` | `online` / `grace` / `offline` の 3 状態を判定する |
| `src/server/hub.mjs` | long-poll と SSE で待っている相手をまとめて管理する |
| `src/server/server.mjs` | HTTP ルーティング・待ち受け・静的ファイル配信 |
| `src/client/chat.mjs` | CLI クライアント（AI・人間 共用） |
| `src/web/js/markdown.js` | 本文の変換。エスケープを先に済ませる |
| `src/web/js/chat.js` | SSE 受信・送信・参加者一覧の描画 |

## 2. 動作確認の状況

### テスト

`node --test tests/` または `tools/40_test/run-tests.cmd` で全件実行する。

| ファイル | 件数 | 主な内容 |
|---|---:|---|
| `time.test.mjs` | 5 | 固定長・JST・辞書順と時系列順の一致 |
| `config.test.mjs` | 10 | 既定値・環境変数の上書き・カレント非依存・起動ログ |
| `store.test.mjs` | 24 | 採番・取得・接続数・CHECK 制約・WAL・インデックス利用 |
| `presence.test.mjs` | 15 | 3 状態の判定・猶予の境界・一覧の並び順 |
| `maintenance.test.mjs` | 6 | 印があれば待つ・消えたら進む・理由を読む |
| `markdown.test.mjs` | 16 | 生 HTML の無害化・`javascript:` を通さない・記法の描画 |
| `server.test.mjs` | 37 | API 一式・long-poll・SSE・読んだ位置の記録・オフライン通知・`admin/exit` |
| 合計 | **113** | ✅ **全件通過** |

### ブラウザ画面

`N:\2026\PlayWright` の共有環境で、実際に動かして確かめる（サーバーが起動していること）。

```powershell
$env:PW_PROJECT = 'ai-chat-lite'
npm run test:projects -- ai-chat-lite
```

| spec | 内容 |
|---|---|
| `chat-ui.spec.ts` | 表示・送信・Markdown 描画・生 HTML の無害化・SSE 受信・在席の色・コントラスト |
| `contrast.spec.ts` | README・設計・開発状況のコントラスト比 |
| `shot.spec.ts` | スクリーンショットとリンク色の実測 |

コントラスト比が 1.5:1 未満のものは、いずれの資料・画面でも 0 件。

### 実測で確かめたこと

| 確かめたこと | 結果 |
|---|---|
| `node:sqlite` | Node v26.8.1 で experimental 警告なしに動作する |
| WAL モード | 切り替わっている。`N:` の実体はローカルの NTFS なので制約に当たらない |
| インデックス | `WHERE room_id = ? AND msg_seq > ?` が `messages_ix_room_id_msg_seq` を使う |
| `node.exe` のコピー | 単体で動く（98.9 MB）。プロセス名が `node-ai-chat-lite` になり、タスクマネージャで判別できる |
| DB パスの解決 | カレントディレクトリに依存しない。`N:` と実体パスは同じフォルダを指す |
| `N:` の正体 | `subst` の仮想ドライブ。サービスからは見えないため、登録は実体のフォルダで行う |
| long-poll | 待機中は `online`、投稿で即座に起床、終了後は `grace` に落ちる |
| **管理者権限なしの入れ替え** | `restart` でプロセスが落ち、10 秒後に新しいコードで起動する。**WinSW ごと起動し直されるため XML も読み直される**（ポートやログ設定の変更も反映される） |
| サービス回復の設定 | 「1 回目」「2 回目」「それ以降」の 3 段階。3 つ書けば打ち止めにならない。`resetfailure` は 60 秒 |
| 読んだ位置 | サーバーが `cursors` に覚える。`since` を省略しても続きから届き、実行するフォルダを変えても位置が保たれる |
| メンテナンスの印 | `_data\MAINTENANCE` があると起動を保留する。**待機中は DB を掴んでいない**（リネームできることを確認）。印を消してから **0.8 秒**で起動した |
| `logpath` の落とし穴 | **相対パスはサービスのカレント（`C:\Windows\System32`）基準で解決される。**`%BASE%\logs` と書く必要がある |

### ログの置き場

| ファイル | 中身 |
|---|---|
| `logs\…-winsw.out.log` | サーバーの標準出力（起動ログ・警告） |
| `logs\…-winsw.err.log` | 標準エラー。`ERROR` だけがここに来る |
| `logs\…-winsw.wrapper.log` | WinSW 自身のログ。起動・停止・子プロセスの ID |

アプリはファイルに書かない。行き先は起動する側が決める。手で起動すればコンソールに出て、テストからならパイプで受け取れる。

## 3. 課題

これから解決することは[課題](../40_issues/issues.md)に移した。状態（未・着手・済）を持たせ、片付いたものも残してある。

この資料は「いまどうなっているか」を書く。「これから何をするか」は課題側にある。

[README へ戻る](../../README.md)
