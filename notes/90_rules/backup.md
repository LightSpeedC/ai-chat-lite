# バックアップの手引き

控えの取り方・戻し方・困ったときの見どころ

> 📅 作成: 2026-08-30 / 更新: 2026-08-30

[README へ戻る](../../README.md)

普段は自動で動くので何もしなくてよい。**手を出すのは、戻したいときと、動いていないと気づいたときだけ**。なぜこの形にしたかは[バックアップ設計](../10_plan/20260830-01-バックアップ.md)にある。

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
| タスクを登録する | 4 つ登録する。既に同じ名前があれば作り直す |

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
| 1 | `_data\MAINTENANCE` を置く。この印がある間、サーバーは起動せず待つ |
| 2 | サーバーを落とす。印があるので、起動しようとして待機に入る |
| 3 | zip を展開し、中身の件数を数えて確かめる |
| 4 | いまの DB を `_data\prev-yyyymmdd-hhmmss\` へ移し、入れ替える |
| 5 | 印を消す。サーバーが自分から起動する |

数秒で起動する。`http://localhost:8787/` を開いて確かめる。

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
Get-ScheduledTask -TaskName 'ai-chat-lite バックアップ*' |
	Get-ScheduledTaskInfo |
	Select-Object TaskName, LastRunTime, LastTaskResult
```

| `LastTaskResult` | 意味 |
|---:|---|
| 0 | 取れた。または**印があったので見送った**。どちらも正常 |
| 0 以外 | 取れなかった。DB が読めない、書き込めないなど。調べる必要がある |

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
