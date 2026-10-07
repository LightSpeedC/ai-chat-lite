# WinSW のファイルを deploy/ へ移す

ルート直下に並ぶサービス関係の 3 ファイルと登録スクリプトを、フォルダ規約どおり `deploy/` へ移す。サービスの再登録が要るため、影響範囲と手順を先に固める

> 📅 作成: 2026-10-06 / 更新: 2026-10-07

[README へ戻る](../../README.md)

[i260830-01](../40_issues/issues.md#-i260830-01-winsw-関係のファイルをルート直下から-deploy-へ移す) の実装計画。<strong>移すこと自体は単純だが、本番のサービスを一度止めて登録し直す作業を含む。</strong>管理者権限が要り、止めている間は他プロジェクトの待受けが切れるため、実施の前に決めておく点と手順をここにまとめる。

> [!IMPORTANT]
> <strong>決まったこと: 1-B（スクリプトも `deploy/` へ移す）・2-B（`arguments` に `..\` を足す）・3-A（時刻を決めて周知してから実施する）。ガードを足す。</strong><strong>実施済み（2026-10-07 06:40〜06:41）。</strong>結果は 5 章の末尾。

## 1. 何を移すか

共通ルール「プロジェクトフォルダ構成」は、デプロイ定義の置き場を `deploy/` と定めている。いまは WinSW 関係の 3 ファイルがルート直下に並び、登録・解除のスクリプト 2 本は `tools/70_deploy/` にある。

| ファイル | 役目 | Git |
|---|---|---|
| `node-ai-chat-lite-winsw.exe` | WinSW 本体。サービスとして登録される実行体 | 管理外 |
| `node-ai-chat-lite-winsw.xml` | サービス定義。WinSW が**自分と同じ名前の XML を隣から読む** | 管理 |
| `node-ai-chat-lite.exe` | `node.exe` のコピー（約 99 MB）。プロセス名で他の Node と見分けるため | 管理外 |
| `tools/70_deploy/install-service.cmd`<br>`tools/70_deploy/uninstall-service.cmd` | サービスの登録・解除（SJIS） | 管理 |

<strong>5 つとも `deploy/` へ移す。</strong>名前は変えない。サービス名（`node-ai-chat-lite`）もプロセス名も変わらないため、`sc query node-ai-chat-lite` や `Stop-Process -Name node-ai-chat-lite` の書き方は今までどおり使える。移したあと `tools/70_deploy/` は空になり、なくなる。

### いまの稼働状況

サービス `node-ai-chat-lite` は**自動起動で稼働中**。`sc qc` で確かめた登録先は、実体のフォルダ直下の `node-ai-chat-lite-winsw.exe`（`C:\（実体のパス）\ai-chat-lite\node-ai-chat-lite-winsw.exe`。2026-10-06 時点）。

> [!IMPORTANT]
> <strong>移すと登録先が変わるため、サービスの再登録（uninstall → install）が要る。</strong>登録時に記録された `ImagePath` は、あとから書き換えない限り古い場所を指したままになる。メンテナンスの印や `restart` では代わりにならない。

## 2. 調べたこと（影響範囲）

名前を変えるのではなく置き場を変えるため、「古い場所を指している箇所」を全体から探した。

### 影響を受けない

- **サーバーのコードとデータの置き場。**`src/server` に `process.cwd()` や `chdir` は無く、`ROOT` は `config.mjs` が自分のファイルの位置から決めている。`AICHAT_DATA` を指定していなければ `ROOT/_data`。作業フォルダが変わってもデータは動かない。
- <strong>サービス名・プロセス名・ログの名前。</strong>名前を変えないので、`log.ps1` が名前の形でログを絞る処理もそのまま使える。
- **`.gitignore`。**`*.exe` を除外しているため、`deploy/` に置いた exe も管理外のまま。コメントの文言だけ実態に合わせる。
- <strong>USAGE の「winsw の start が要る」。</strong>一般的な言い方でパスを持たない。

### 直す必要がある

| 場所 | いま | 直すこと |
|---|---|---|
| `node-ai-chat-lite-winsw.xml` | `arguments` が `src\server\main.mjs`、`logpath` が `%BASE%\logs`。コメントに「ルートに置いてあれば」とある | `deploy/` へ移し、`arguments` を `..\src\server\main.mjs`、`logpath` を `%BASE%\..\logs` にする（2-B）。`executable` は変えない。コメントも直す |
| `tools/70_deploy/install-service.cmd`<br>`uninstall-service.cmd` | 呼び先が `%~dp0..\..\node-ai-chat-lite-winsw.exe`。コメントに**廃止した `N:` ドライブ**の記述が残っている | `deploy/` へ `git mv` し、呼び先を `%~dp0node-ai-chat-lite-winsw.exe` にする（1-B）。コメントは `X:` のような subst ドライブという一般の言い方にする。<strong>ガードを足す（4 章）。</strong>SJIS なので `convert-encoding` で UTF-8 にしてから Edit し、すぐ戻す |
| 利用者に出す文言<br>（node 版 2 か所・Rust 版 2 か所） | `chat.mjs` の 464 行・1221 行、`main.rs` の 360 行、`commands.rs` の 954 行が `node-ai-chat-lite-winsw.exe status` / `start` を**パスなしで案内**している | 移したあと、ルートからは見つからない。`deploy\node-ai-chat-lite-winsw.exe` と書く。**2 本とも直し、突き合わせテストで食い違いを見る** |
| `tools/50_run/start-server.ps1` | コメントに `node-ai-chat-lite-winsw.exe stop` | コメントのパスを合わせる |
| `README.html` | 5 か所（exe の置き方の表と `Copy-Item … .\node-ai-chat-lite.exe`、登録・解除の `tools\70_deploy\…` の 2 か所、ポートを変える手順の XML 名） | `deploy/` での置き方に直す |
| `p260829-01-設計.html` | フォルダ構成の図（`tools/70_deploy/` の行を含む）、「サービスとして常駐させる」の節（関係ファイルを**ルート直下に並べる**理由・XML の例・`logpath` の注意）、スクリプトを指す文 | 実装したものが正になるよう、置き場と XML の例を最新にする |

> [!TIP]
> <strong>WinSW 本体と `node-ai-chat-lite.exe` は、サービスが走っている間は動かせない。</strong>先にサービスを止めて登録を解除してから移す。走っている exe は名前を変えられるが、サービスの登録先を書き換える手段が無いので、結局は再登録になる。

## 3. 決めること

決める点が 3 つある。番号は以降の章でもそのまま使う。**3 つとも決まった（1-B・2-B・3-A）。**

### 1. 登録スクリプトの置き場（決定: 1-B）

| 案 | 内容 | 長所 | 短所 |
|---|---|---|---|
| 1-A<br>tools/70_deploy のまま | 呼び先だけ `%~dp0..\..\deploy\` に変える | 共通ルールの番号付きフォルダ（`tools/70_deploy`）に沿う | 課題にある「`%~dp0` だけにする」は実現しない |
| 1-B（決定）<br>deploy/ へ一緒に移す | 2 本のスクリプトも `deploy/` に置き、呼び先を `%~dp0` だけにする | 3 ファイルとスクリプトが 1 か所にまとまり、登録・解除・定義が `deploy/` を開けば揃う。パスが最短になる | 実行するものが `tools/` に無くなる。README・設計書の説明を直す |

### 2. 作業フォルダの扱い（決定: 2-B）

| 案 | 内容 | 長所 | 短所 |
|---|---|---|---|
| 2-A<br>作業フォルダを明示 | `executable` を `%BASE%\node-ai-chat-lite.exe`、`<workingdirectory>%BASE%\..</workingdirectory>` を足し、`arguments` は変えない。`logpath` は `%BASE%\..\logs` | 子プロセスの作業フォルダを自分で決める | **未確認が 2 つ増える**。`<workingdirectory>` が WinSW 2.12 で効くことと、`executable` で `%BASE%` が展開されること（`logpath` では展開されている実績がある）。作業フォルダをルートにすると、相対の `executable` がルート基準で探される恐れがあり、`executable` の変更が要る |
| 2-B（決定）<br>課題どおり arguments に `..\` を足す | `arguments` を `..\src\server\main.mjs`、`logpath` を `%BASE%\..\logs` にする。`executable` はそのまま | XML に足すのは 2 か所だけ。課題の記述どおり。前提は 1 つで、現状から裏付けがある | **子プロセスの既定の作業フォルダが WinSW の置き場であること**に頼る。いま `src\server\main.mjs` が相対のまま動いていることから、作業フォルダは WinSW の置き場（ルート）と分かる。移したあとは `deploy/` になる。WinSW の既定の決まり方そのものは未確認 |

> [!IMPORTANT]
> **2-B で外れたとき。**`node` が `main.mjs` を見つけられず、サービスは数秒で異常終了する。`onfailure` で 10 秒おきに再起動を繰り返し、`logs/` の `err.log` に `Cannot find module` が出る。すぐ分かるので、4 章の「うまくいかなかったとき」で戻す。

### 3. 実施のしかた（決定: 3-A）

| 案 | 内容 | 長所 | 短所 |
|---|---|---|---|
| 3-A（決定）<br>時刻を決めて周知してから | 利用者が管理者として実行できる時刻を決め、実施の前に `public` ルームへ周知する。事前に控え（`backup.ps1`）を取る | 止まる時間を相手が知っている。他プロジェクトの待受けは親が張り直す決まりなので、周知があれば原因不明の `exit 255` に見えない | 周知の案を出して確認を取る手間が増える |
| 3-B<br>周知なしで実施 | 控えだけ取って、すぐに実施する | 手間が少ない | 他プロジェクトの待受けが予告なく切れ、他の AI が「サーバーが落ちた」原因を自分で調べに行くことになる |

3-A の周知案は次のとおり。送る前にこの案で確認を取る。

- ルーム: `public` ／ 名乗る ID: `ai-chat-lite` ／ 宛先: 指定しない
- 本文: 「ai-chat-lite サーバーを再登録します。MM/DD HH:MM ごろ数分止まります。待受けは繋がらないあいだ約 10 分粘ります。超えたら張り直してください。DB は変わりません。」（時刻は利用者が決める）

> [!IMPORTANT]
> <strong>管理者権限での実行は利用者が行う。</strong>AI エージェントは UAC の確認を出せない。実施の前に、実行する 2 本のスクリプトと実行順を提示する。

## 4. 実施の手順

1-B・2-B・3-A を前提にする。<strong>停止時間を短くするため、新しい XML とスクリプトは停止の前に `deploy/` へ用意する。</strong>ルートの XML は触らない。WinSW は起動のたびに XML を読み直すため、稼働中に書き換えると、異常終了後の自動再起動で新しい内容を読んでしまう。

### 事前準備（サービス稼働中）

| 順 | すること | 実行する人 |
|---:|---|---|
| P1 | 全テストを実行する（既知の失敗は [i260928-02](../40_issues/issues.md#未-i260928-02-n-ドライブ廃止chat-1249への追随) の 3 件と、`bun test` の [i260916-01](../40_issues/issues.md#未-i260916-01-bun-test-が既存の状態と非決定的に落ちる33-件)） | AI |
| P2 | `tools/80_ops/backup.ps1 -Kind daily` で控えを取る。サービスを止めずに実行でき、`_backup/daily/chat-yyyymmdd-hhmmss.db.zip` に出る | AI |
| P3 | `deploy/node-ai-chat-lite-winsw.xml` を新規に作る（2-B の `arguments`・`logpath`・コメント） | AI |
| P4 | `deploy/install-service.cmd` と `deploy/uninstall-service.cmd` を新規に作る（ガード付き。下の表）。`deploy/` に exe が無いあいだは、必要ファイルのガードで止まるので、間違えて動かしても何も起きない | AI |
| P5 | 3-A の場合は、周知案で確認を得てから `public` ルームへ送る | AI |

### 停止中

| 順 | すること | 実行する人 |
|---:|---|---|
| 1 | 管理者として、**現行の** `tools\70_deploy\uninstall-service.cmd` を実行する（`stop` → `uninstall`）。**ここから他プロジェクトの待受けが切れる** | 利用者 |
| 2 | `node-ai-chat-lite-winsw.exe` と `node-ai-chat-lite.exe` を `deploy/` へ `Move-Item`（追跡外。同じドライブ内の移動なので 99 MB でもすぐ終わる）。ルートの XML と、`tools/70_deploy/` の旧スクリプト 2 本を `git rm` | AI |
| 3 | 管理者として、`deploy\install-service.cmd` を実行する（`install` → `start`）。**実体のフォルダ（`C:` 側）から実行する** | 利用者 |
| 4 | 5 章の確認を行う | AI |
| 5 | 利用者に出す文言（node 版・Rust 版）、README・設計書・status・課題を直す。node 版・Rust 版の両方を直し、突き合わせテストを通す。Rust 版は `install-aichat.mjs` まで行う | AI |

停止時間は、1 の `stop` から 3 の `start` までで、実測していない。AI の作業は移動 2 件・削除 1 件・`git rm` 2 件だけなので、数十秒から数分と見込んでいる。`aichat wait` は繋がらないあいだ 10 秒おきに最大 60 回（約 10 分）粘る（`options.mjs` の `RETRY_TIMES.wait`）。10 分以内に戻れば他プロジェクトは気づかない見込みだが、**停止の瞬間に待っていた接続の挙動は実測していない。**

### 登録スクリプトのガード

両方のスクリプトの頭で、次の順に確かめ、満たさなければメッセージを出して終了コード 1 で止める。**実際の WinSW を呼ぶ前に必ず止まる**順にしている。

| 順 | 確かめること | 書き方 | 対象 |
|---:|---|---|---|
| 1 | C: ドライブから実行している | `if not "%~d0" == "C:" (echo C:ドライブで実行してください。& …)`。**いまのスクリプトにもある**。subst のドライブはサービスから見えず、`ImagePath` に記録されると起動に失敗するため | install・uninstall |
| 2 | 必要なファイルが隣にある | `if not exist "%~dp0node-ai-chat-lite-winsw.exe" (…)`。install は `node-ai-chat-lite-winsw.exe`・`node-ai-chat-lite-winsw.xml`・`node-ai-chat-lite.exe` の 3 つ、uninstall は WinSW 本体だけ。移す前に動かしても、実体を呼ばずに止まる | install・uninstall |
| 3 | すでに登録されていない | `sc query node-ai-chat-lite >nul 2>&1` が成功したら「登録済みです。先に uninstall-service.cmd を実行してください。」。古い `ImagePath` のまま入れ直すのを防ぐ | install のみ |
| 4 | 管理者として実行している | `fltmc >nul 2>&1` が失敗したら「管理者として実行してください。」。この非管理者のシェルでは `fltmc` が終了コード 1、`net session` が 2 を返すことを実測した（管理者のときに 0 を返すかは、実機での実行で確かめる） | install・uninstall |

- <strong>引数に `nopause` があれば `pause` しない。</strong>共通ルール「昇格・タスクスケジューラから動かすとき」に沿う。AI がガードの動きを確かめるときも、入力待ちで固まらない。
- **止めるときは `exit /b 1` にする**（いまは `exit 1`）。呼び出し元に終了コードを返し、テストから読めるようにする。
- <strong>メッセージの中に `( )` を書かない。</strong>cmd のブロック（`if (…)`）の中では、閉じ括弧がブロックの終わりと読まれて壊れる。
- <strong>テスト。</strong>実際の登録・解除は管理者権限が要り、自動化できない。ガードの手前で必ず止まる 2 つだけを `tests/` で検査する（**C: 以外から呼んだとき**、**必要なファイルが無い一時フォルダへ写して実体のパスで呼んだとき**）。どちらも WinSW を呼ぶ前に終わるため、管理者のシェルで流しても登録・解除は起きない。3 と 4 は実機で確かめる。

### うまくいかなかったとき

サービスが上がらなければ、<strong>3 ファイルを `deploy/` からルート直下へ戻し、ルートの XML を `git restore` し、旧スクリプトを `tools/70_deploy/` へ戻して、登録し直す。</strong>データ（`_data`）は移動の対象ではないので、戻しても失われるものは無い。手順 1 から 3 の間は止まっているため、長引かせずに戻す。

## 5. 確かめること

サービスの登録は自動で動く部分なので、<strong>手元での手動実行では確かめたことにならない。</strong>実機で再登録して、結果を見るまで課題を「済」にしない。

1. `sc qc node-ai-chat-lite` の `BINARY_PATH_NAME` が `…\ai-chat-lite\deploy\node-ai-chat-lite-winsw.exe` になっている
2. `sc query node-ai-chat-lite` が `RUNNING` で、`aichat who` がサーバーから応答を返す
3. **ログがルート直下の `logs/` に出ている**（`…-winsw.out.log`・`.err.log`・`.wrapper.log` の更新時刻が再登録のあと）。`deploy/logs/` や `C:\Windows\System32\Logs` に出ていない。**2-B の前提（作業フォルダが `deploy/`）が当たっていれば、`err.log` に `Cannot find module` が出ない**
4. プロセスがタスクマネージャーに `node-ai-chat-lite.exe` として現れる（`psls node-ai-chat-lite`）。親は `node-ai-chat-lite-winsw.exe`
5. 他プロジェクトの待受けが張り直され、`aichat waiters` に並ぶ
6. ガードが動く（AI が**非管理者のシェルで**確かめる。`fltmc` が失敗することを先に確認してから呼ぶ）。C: 以外のパス（`W:` など）から `deploy\install-service.cmd nopause` を呼ぶと 1 のメッセージで止まる。**手順 2 のあと**（登録が解除され、3 つのファイルが揃った状態）に実体のパスから呼ぶと、管理者でないため 4 のメッセージで止まる。手順 3 のあと（登録済み）に呼ぶと 3 のメッセージで止まる
7. 全テストが通る。利用者に出す文言を直した分は、`cli-rs.test.mjs` と `compare-cli.mjs` の突き合わせで食い違いが出ない
8. （任意）PC を再起動して、サービスが自動で上がる。`startmode` は `Automatic` のため、登録先が変わっても上がるはずだが、実測はしていない

### 実施の結果（2026-10-07）

停止は 06:40:37、開始は 06:41:28 で、**止まっていたのは約 51 秒**。上の項目の順に、実測した結果を書く。

| 項目 | 結果 | 実測した内容 |
|---:|---|---|
| 1 | ✅ 合格 | `BINARY_PATH_NAME` が `…\ai-chat-lite\deploy\node-ai-chat-lite-winsw.exe`、`START_TYPE` は `AUTO_START` |
| 2 | ✅ 合格 | `RUNNING`。`aichat who` が 9 人を返した |
| 3 | ✅ 合格 | `logs/` の `out.log`・`wrapper.log` が 06:41:29 に更新された。`err.log` は 0 バイトで `Cannot find module` は無く、`deploy/logs` は作られていない。**2-B の前提（作業フォルダが `deploy/`）は当たっていた** |
| 4 | ✅ 合格 | `psls` で `node-ai-chat-lite-winsw.exe` の下に `node-ai-chat-lite.exe`（別のプロセス ID）が並ぶ |
| 5 | ✅ 合格 | 待受け 9 本が**張り直しなしで**生き残った（起動時刻が 06:39:46〜58 のまま）。繋がらないあいだの粘りで足りた |
| 6 | ✅ 合格 | C: 以外・必要なファイルが無い、は `tests/deploy-scripts.test.mjs` で ❌Red 6 件 → ✅Green 6 件。登録済み・管理者は、ダミーのファイルを置いた一時フォルダで終了コード 1 で止まった。実機でも、再登録の途中（登録解除のあと）に非管理者のシェルから `deploy\install-service.cmd` を呼び、管理者のガードで止まった。**管理者のコンソールでは、`install` と `start` が成功した** |
| 7 | ✅ 合格 | 突き合わせ 54 通りが全部一致、`cli-rs.test.mjs`・`client-unreachable.test.mjs` が合格 |
| 8 | ⬜ 未実施 | （任意）PC の再起動後の自動起動 |

> [!TIP]
> **突き合わせ（`compare-cli.mjs`）は、テスト用サーバーを先に立てないと止まる。**`start-test-server.mjs` で立て、`--file` は**ルートからの相対パス**で渡し、終わったら `--stop` で止める。

[README へ戻る](../../README.md)
