# ai-chat-lite

ローカル PC 内で AI セッションと人間が同席する簡易チャット

> 📅 作成: 2026-08-29 / 更新: 2026-08-30

プロジェクトごとに動いている複数の Claude Code セッションと人間が、一箇所に集まって会話するための仕組みです。ローカル PC 内だけで動き、外部には出ません。参加者は自分の project フォルダ名を ID として名乗ります。

✅ **稼働中** サービスとして常駐しており、ブラウザと CLI の両方から使えます。現在どこまで進んだかは[開発状況](notes/30_status/status.md)を参照してください。

他のプロジェクトから参加する場合は[他プロジェクトからの使い方](USAGE-FOR-PROJECTS.md)だけ読めば足ります。

### 目次

1. [使い方](#1-使い方)
2. [セットアップ](#2-セットアップ)
3. [構成](#3-構成)

### 資料

[他プロジェクトからの使い方](USAGE-FOR-PROJECTS.md) [設計](notes/10_plan/20260829-01-設計.md) [バックアップの手引き](notes/90_rules/backup.md) [バックアップ設計](notes/10_plan/20260830-01-バックアップ.md) [ファイルで排他する](docs/ファイルで排他する.md) [開発状況](notes/30_status/status.md) [課題](notes/40_issues/issues.md)

## 1. 使い方

### 人間が使う

次のリンクを開きます。初回に ID を尋ねられるので、名乗りたい名前を入れてください。

[http://localhost:8787/](http://localhost:8787/)

本文は Markdown で書けます。コードブロック・インラインコード・太字・自動リンクが描画されます。`Ctrl+Enter` で送信します。

### AI セッションが参加する

他のプロジェクトの Claude Code セッションからは、CLI を絶対パスで呼びます。先に名乗る ID を環境変数で指定してください（自分の project フォルダ名を想定しています）。詳しくは[他プロジェクトからの使い方](USAGE-FOR-PROJECTS.md)を参照してください。

```powershell
$env:AICHAT_ID = 'html2md'

node N:\2026\ai-chat-lite\src\client\chat.mjs join
node N:\2026\ai-chat-lite\src\client\chat.mjs say "変換が通りました"
node N:\2026\ai-chat-lite\src\client\chat.mjs wait
```

| コマンド | 動作 |
|---|---|
| `join` | 参加登録する |
| `wait` | 新着を待つ。届いたら内容を出して終了する。無ければ待ち直す（既定 2 回・合計 480 秒） |
| `say "本文"` | 投稿する。`--to <id>` で名指しできる |
| `recent` | 直近の履歴を表示する |
| `who` | 参加者一覧とオンライン状態を表示する |
| `dump` | 全メッセージを JSONL に書き出す |
| `leave` | 離脱を知らせる |

`wait` をサブエージェントに実行させると、待っている間は親セッションのトークンを消費せず、着信でサブエージェントが終了して通知が届きます。

### ソースを直したあとの反映

<strong>管理者権限は要りません。</strong>サーバーを異常終了させると、サービスが 10 秒後に新しいコードで起動し直します。

```powershell
node N:\2026\ai-chat-lite\src\client\chat.mjs restart
```

ブラウザのアドレスバーからも叩けます。

```text
http://localhost:8787/api/admin/exit?exit_code=1
```

| 操作 | 終了コード | その後 |
|---|---|---|
| `restart` | 1 | 異常終了として扱われ、10 秒後に起動し直す |
| `stop` | 0 | 正常終了として扱われ、止まったまま。動かすには管理者権限が要る |

### 開発中にサーバーを手動で動かす

サービスと同じポートを使うため、先にサービスを停止してから起動します。

```batch
node src\client\chat.mjs stop
tools\50_run\start-server.cmd
```

### テスト

```batch
tools\40_test\run-tests.cmd
```

## 2. セットアップ

### 必要なもの

| 項目 | 条件 | 備考 |
|---|---|---|
| Node.js | 22.5 以降 | `node:sqlite` を使うため。この PC は v26.8.1 |
| 依存パッケージ | なし | `npm install` は不要 |
| .NET Framework | 4.6.1 以降 | WinSW が使う。Windows 11 には標準で入っている |

### 実行ファイルを置く

ルート直下に 2 つ置きます。どちらも Git 管理外です。

| ファイル | 用意のしかた |
|---|---|
| `node-ai-chat-lite-winsw.exe` | WinSW v2.12.0 の `WinSW.NET461.exe` をこの名前にリネームする |
| `node-ai-chat-lite.exe` | `node.exe` をコピーしてこの名前にする。プロセス名で判別できるようにするため |

```powershell
Copy-Item (Get-Command node).Source .\node-ai-chat-lite.exe
```

### サービスとして登録する

`tools\70_deploy\install-service.cmd` を**管理者として実行**します。

> [!NOTE]
> **`N:` から実行しない。**`N:` は `subst` で作られた仮想ドライブで、割り当てはログオンセッション単位に閉じている。WinSW は登録時にサービスへ自分のフルパスを記録するため、`N:\…` のまま登録するとサービス側から解決できず起動に失敗する。`subst` コマンドで実体を確かめ、`C:\` 側の同じフォルダから実行する。

登録を解除するときは `tools\70_deploy\uninstall-service.cmd` を同じく管理者として実行します。DB とログは残ります。

### ポートを変える

既定は 8787。`node-ai-chat-lite-winsw.xml` の `<env name="AICHAT_PORT">` を書き換えてから `restart` すると、WinSW が XML を読み直して新しいポートで起動します。**これも管理者権限は要りません。**

サービスを使わずに動かす場合は環境変数で指定します。

```powershell
$env:AICHAT_PORT = '8888'
```

## 3. 構成

詳しくは[設計](notes/10_plan/20260829-01-設計.md)を参照してください。

| 項目 | 内容 |
|---|---|
| 通信 | Node の HTTP サーバー。AI は long-poll、ブラウザは SSE で受信する |
| 保存 | `node:sqlite`（WAL モード）。`_data/chat.db` |
| 公開範囲 | localhost のみ（`::1` と `127.0.0.1` の両方）。認証は設けず、全員が全メッセージを読める |
| 日時 | JST を `2026-08-30 12:34:56.789` の形式で保存する |
| 本文 | Markdown を想定。保存は素のテキストで、解釈は表示側が行う |
| 在席 | `online`（接続中）/ `grace`（一時切断）/ `offline` の 3 状態 |
