# バックアップの手引き

控えの取り方・戻し方・困ったときの見どころ

> 📅 作成: 2026-08-30 / 更新: 2026-09-01

[README へ戻る](../../README.md)

普段は自動で動くので何もしなくてよい。**手を出すのは、戻したいときと、動いていないと気づいたときだけ**。なぜこの形にしたかは[バックアップ設計](../10_plan/p260830-01-バックアップ.md)にある。

### 目次

1. [はじめる](#1-はじめる)
2. [戻す](#2-戻す)
3. [確かめる](#3-確かめる)
4. [やってはいけないこと](#4-やってはいけないこと)

## 1. はじめる

<strong>管理者権限は要らない。</strong>ログオンしているユーザーのタスクとして動く。

### 1 度だけやること

```batch
tools\80_ops\migrate-backup-layout.cmd
tools\80_ops\register-backup-tasks.cmd
```

| やること | 中身 |
|---|---|
| 置き場を整える | 区分を分ける前のものを `hourly` へ移し、最新の 1 本を残り 3 区分にも配る。配らないと `monthly` が空のまま翌月 1 日まで待つことになる |
| タスクを登録する | タスクスケジューラの `\ai-chat-lite\` フォルダに 4 つ登録する。フォルダは自動で作られる。既に同じ名前があれば作り直す |

登録されるのはこの 4 つ。**名前に時刻が入っているので、一覧の並び順がそのまま実行順になる**。

| タスク名 | 区分 |
|---|---|
| `ai-chat-lite バックアップ 00時00分 (毎時)` | `hourly` |
| `ai-chat-lite バックアップ 00時01分 (毎日)` | `daily` |
| `ai-chat-lite バックアップ 00時02分 (毎週)` | `weekly` |
| `ai-chat-lite バックアップ 00時03分 (毎月)` | `monthly` |

### いつ取られるか

| 区分 | 取る時刻 | 残る数 | 遡れる範囲 |
|---|---|---:|---|
| `hourly` | 毎時 0 分 | 8 | 8 時間 |
| `daily` | 毎日 0 時 1 分 | 7 | 1 週間 |
| `weekly` | 月曜 0 時 2 分 | 4 | 1 か月 |
| `monthly` | 1 日 0 時 3 分 | 6 | 半年 |

PC が寝ていて時刻を過ぎたときは、起きたあとに取り返す。<strong>サービスは止めなくてよい。</strong>読み取り専用で複製するので、動いたまま取れる。

### いま取っておきたいとき

DB を触る前など、手で 1 本取りたいときは区分を指定して呼ぶ。

```powershell
tools\80_ops\backup.ps1 -Kind hourly
```

置き場は `_backup\<区分>\chat-yyyymmdd-hhmmss.db.zip`。

## 2. 戻す

```batch
tools\80_ops\restore.cmd
```

いちばん新しいものが選ばれる。**区分をまたいで新しい順に並べる**ので、どこにあるかを気にしなくてよい。確認を求められたら `yes` と入力する。

### 選んで戻す

```powershell
tools\80_ops\restore.ps1 -Path _backup\daily\chat-20260828-000100.db.zip
```

### 何が起きるか

| 順 | すること |
|---:|---|
| 0 | <strong>これから止めることを `public` に流し、10 秒待つ。</strong>印を置く前に投稿する（置いてからでは受け付けてもらえない） |
| 1 | `_data\MAINTENANCE` を置く。理由と `見込み: N 分` を書く |
| 2 | サーバーを落とす。印があるので、**待ち受けだけ始めて DB は開かない** |
| 3 | zip を展開し、中身の件数を数えて確かめる |
| 4 | いまの DB を `_data\prev-yyyymmdd-hhmmss\` へ移し、入れ替える |
| 5 | 印を消す。**受け口が通常に切り替わり、再開したことを `public` に流す** |

数秒で起動する。`http://localhost:8787/` を開いて確かめる。

> [!TIP]
> <strong>止めている間もポートは開いている。</strong>繋いだ側には 503 と理由が返り、画面には帯が出る。「繋がらない」で落ちるのではないので、**メンテナンス中だと分かる**。
> 待受けを張っている相手は 10 分まで繋ぎ直すので、その間に終われば**何ごともなかったように繋がり直す**。

#### 見込みを変える

既定は 5 分。長くかかると分かっているときは渡す。**案内の本文と `Retry-After` の両方に効く**。

```powershell
tools\80_ops\restore.ps1 -EstimatedMinutes 20
```

### 戻したものが違っていたら

**いまの DB は消していない。**`_data\prev-yyyymmdd-hhmmss\` に 3 つのファイルが入っている。元に戻すには、印を置いてサーバーを落とし、3 つとも `_data` へ戻す。

```powershell
echo 戻し直しています > _data\MAINTENANCE
node src\client\chat.mjs restart

# _data\prev-… の中身 3 つを _data\ へ移す（chat.db / chat.db-wal / chat.db-shm）

Remove-Item _data\MAINTENANCE
```

> [!CAUTION]
> **3 つとも戻すこと。**`chat.db` だけを戻すと、直近の発言がまとめて消える。実測では 64 件のすべてが `chat.db-wal` 側にあり、本体は空同然だった。

## 3. 確かめる

### ちゃんと取れているか

```powershell
Get-ChildItem _backup -Recurse -Filter 'chat-*.db.zip' |
	Group-Object { $_.Directory.Name } |
	Select-Object Name, Count
```

数が増えていない区分があれば、タスクが動いていない。

```powershell
Get-ScheduledTask -TaskPath '\ai-chat-lite\' |
	Get-ScheduledTaskInfo |
	Select-Object TaskName, LastRunTime, LastTaskResult
```

> [!NOTE]
> <strong>`-TaskPath` を省くと見つからない。</strong>タスクは `\ai-chat-lite\` フォルダに置いてある。名前だけで `Get-ScheduledTask` を呼んでも 0 件になる。

### やめるとき

```batch
tools\80_ops\unregister-backup-tasks.cmd
```

4 つとも解除し、**空になったフォルダも消す**。ほかのタスクが同じフォルダに残っていれば、フォルダは消さずにそのままにする。

控え（`_backup`）は消さない。要らなくなったら手で消す。

| `LastTaskResult` | 意味 |
|---:|---|
| 0 | 取れた。印を待った場合も、待った末に取れていれば 0 |
| 0 以外 | <strong>その回の控えが無い。</strong>DB が読めない、印が 5 分待っても消えなかった、など。調べる必要がある |

### 中身を見たいとき

<strong>zip を展開して、そのコピーを開く。</strong>控えそのものを直接開かない。

```powershell
Expand-Archive _backup\daily\chat-20260828-000100.db.zip -DestinationPath tmp\peek
node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('tmp/peek/chat.db');console.log(d.prepare('SELECT count(*) c FROM messages').get().c + ' 件');d.close();"
```

### 全部止まっているとき

どの区分も取れていないなら、**印が残っている**可能性がある。

```powershell
Get-Content _data\BACKUP-RUNNING
Get-Content _data\MAINTENANCE
```

| 印 | 対処 |
|---|---|
| `BACKUP-RUNNING` | 中身に開始時刻と `pid` が書いてある。**30 分より古ければ次の実行が自分で奪う**ので、待てばよい。急ぐなら `Get-Process -Id <pid>` で本当に動いていないことを確かめてから消す |
| `MAINTENANCE` | 人が置いたもの。<strong>勝手に消さない。</strong>DB を触っている最中かもしれない。置いた人に確かめる |

> [!CAUTION]
> <strong>メンテナンスの印を消し忘れると、控えが 1 本も取れなくなる。</strong>作業が終わったら必ず消すこと。消し忘れている間は毎時 `ERROR` が出て、タスクの履歴も赤くなる。**赤が並んでいたら、まず印を疑う。**

## 4. やってはいけないこと

> [!CAUTION]
> **`chat.db-wal` と `chat.db-shm` を消さない。例外はない。**`-wal` には本体にまだ統合されていない書き込みが入っている。消せばその分が失われ、本体だけが残る。<strong>本体の大きさから中身の量は判断できない。</strong>実測では 40 KB の本体に 0 件、2.6 MB の `-wal` に 64 件すべてが入っていた。
> 捨てるときは 3 つまとめて捨て、残すときは 3 つまとめて残す。

| やってはいけない | なぜ | 代わりに |
|---|---|---|
| `chat.db` だけをコピーする | 中身が入っていないことがある | `backup.ps1` を使う。`VACUUM INTO` が 3 つを織り込んだ 1 ファイルを作る |
| 控えを直接開く | 読むだけでも `-wal` と `-shm` が作られ、閉じても残る | 展開してコピーを開く |
| `MAINTENANCE` を消す | 人が DB を触っている最中かもしれない | 置いた人に確かめる |
| `_backup` を Git に入れる | 発言の中身が履歴に残り、消すには履歴の書き換えが要る | 先頭が `_` なので既に管理外。そのままにする |
| 戻すのに `stop` を使う | 終了コード 0 で**サービスごと止まる**。印を消しても起動せず、管理者権限での再開が要る | `restore.ps1` を使う。中で `restart` を呼んでいる |

[README へ戻る](../../README.md)
