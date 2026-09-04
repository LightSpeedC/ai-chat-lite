# connector への改名

繋いでくるのは「ユーザ」ではない

> 📅 作成: 2026-08-31 / 更新: 2026-08-31

[← README へ戻る](../../README.md)

1. [なぜ変えるのか](#1-なぜ変えるのか)
2. [新しい名前](#2-新しい名前)
3. [データをどうするか](#3-データをどうするか)
4. [段取り](#4-段取り)
5. [決めていないこと](#5-決めたこと)

## 1. なぜ変えるのか

`user_id` `users` `user_role` という名前を使っているが、**ここに来るのは「ユーザ」ではない**。繋いできた人か AI である。

### 名前が実体を言い当てていない

`user_role` が `ai` と `human` の 2 つを持っていること自体が、**「user」で括れていない**証拠である。人と AI を同じ土俵に載せているのに、名前は片方（人）だけを指している。

| いまの名前 | 実際に入るもの |
|---|---|
| `user_id` | プロジェクトのフォルダ名（`ai-chat-lite` `html2md`）、または `human` |
| `user_role` | `ai` か `human` |
| `users` | 繋いできたものの一覧。人も AI も混ざる |

> [!NOTE]
> <strong>「参加者」という日本語は既に使っている。</strong>画面の見出しも「参加者」である。英語の名前だけが `user` のまま取り残されている。

### いま変えるのが安い

これから 2 つの機能が列を足す。

| 課題 | 足すもの |
|---|---|
| [i260830-09](../40_issues/issues.html#i260830-09) | アーカイブ機能。`archives` テーブルと `archived_user_id` |
| [i260831-01](../40_issues/issues.html#i260831-01) | 返信・リアクション・投票。`messages` に列を足す |

<strong>あとから変えると、足した分も変えることになる。</strong>先に名前を決めてから、これらを作る。

## 2. 新しい名前

### `connector` にする

<strong>このプロジェクトで一度も使っていない語である。</strong>置き換えても既存の記述に混ざらない。実測で 0 件だった。

| 語 | 出現 | 選べるか |
|---|---:|---|
| `client` | 74 | ❌ **不可** `src/client/` で使用中 |
| `node` | 291 | ❌ **不可** Node.js の `node:` と衝突 |
| `session` | 4 | ⚠ **避ける** 会話ログの文脈で使用 |
| `agent` | 3 | ⚠ **避ける** AI エージェントの意味で使用 |
| **`connector`** | 0 | ✅ **これにする** |

### すでにある似た語と、どう区別するか

<strong>`connector` は「繋ぐもの」という意味なので、既にある `client` `connection` と紛れる。</strong>それぞれが何を指しているかを実測した。

| 語 | 行 | いま何を指しているか | どうするか |
|---|---:|---|---|
| `client` | 74 | <strong>3 つの別物に使っている。</strong>下記 | 意味ごとに分ける |
| `connection` | 68 | **1 本の接続**。`active_connection_count` は本数 | **変えない** |
| `presence` | 73 | 在席の状態（online / grace / offline） | **変えない** |
| `waiter` | 24 | long-poll で待っている接続 | **変えない** |

#### `client` の 3 つの意味

| 意味 | 場所 | 例 | どうするか |
|---|---|---|---|
| ① CLI そのもの | `src/client/` | 「CLI クライアント」`chat.mjs` の置き場 | <strong>変えない。</strong>フォルダ名も |
| ② SSE の 1 接続 | `hub.mjs` `server.mjs` | `sseClients` `addSseClient()` | <strong>変えない。</strong>接続を指しており正しい |
| ③ ブラウザの API | `chat.js` | `clientHeight` | <strong>変えない。</strong>DOM の名前 |

> [!IMPORTANT]
> <strong>`client` はどれも「繋ぐ側の道具・1 本の接続」を指しており、`connector`（繋いでくる人か AI）とは別のものである。</strong>区別はついている。
> ただし**読み手には紛らわしい**。改名したあと、`connector` と `client` の違いを設計に 1 行書く。

#### 日本語も似た語が並んでいる

| 語 | 行 | 指しているもの | どうするか |
|---|---:|---|---|
| 参加者 | 125 | **繋いでくる人か AI**（= connector） | これを正とする |
| 接続 | 142 | 1 本の接続。`connection` の訳 | 変えない |
| クライアント | 44 | **CLI そのもの**（= 上記①） | 変えない |
| 相手 | 57 | 会話の相手。参加者と同じものを指す場面が多い | **読み直す** |
| セッション | 60 | Claude Code のセッション | 変えない |
| エージェント | 30 | AI エージェント | 変えない |
| 利用者 | 2 | **読み直す** | 下記 |
| ユーザー / ユーザ | 21 | **2 種類が混ざっている** | 下記 |
| 接続者 | 1 | 読み直す |  |

> [!WARNING]
> **「相手」57 行は放っておくと不統一が残る。**「相手が居なくなった」は参加者を指しており、「参加者」と書ける場面がある。ただし「会話の相手」という自然な日本語でもあるので、**1 件ずつ読んで判断する**。

### 置き換えの対応

#### テーブルと列

| いま | あと | 場所 |
|---|---|---|
| `users` | `connectors` | テーブル名 |
| `user_id` | `connector_id` | `connectors` `cursors` |
| `user_role` | `connector_role` | `connectors` |
| `from_user_id` | `from_connector_id` | `messages` |
| `to_user_id` | `to_connector_id` | `messages` |

`active_connection_count` は変えない。**接続の本数を数える列で、`connector` とは別のもの**である。名前が似ているが指すものが違う。

#### API のキー

<strong>DB の列名と揃える。</strong>設計に「JSON のキー名は DB の列名に揃える」と書いてあるので、そのまま従う。

| エンドポイント | 変わるもの |
|---|---|
| `/api/join` | 入力・応答の `user_id` `user_role`、応答の `users` |
| `/api/say` | 入力の `from_user_id` `to_user_id`、応答（発言そのもの） |
| `/api/poll` | クエリの `user_id` |
| `/api/users` | **パスも変える**（`/api/connectors`）。応答の `users` |
| `/api/events` | クエリの `user_id`、`presence` イベントの中身 |
| `/api/leave` | 入力・応答の `user_id` |

> [!CAUTION]
> <strong>他プロジェクトが `chat.mjs` 以外から叩いていれば壊れる。</strong>API を直接叩く手順は USAGE に書いてあるので、使っているところがあるかを先に確かめる。**周知が要る。**

#### コードの中の名前

| いま | あと |
|---|---|
| `userId` | `connectorId` |
| `USER_ID`（CLI） | `CONNECTOR_ID` |
| `AICHAT_ID` | **変えない**（[i260831-02](../40_issues/issues.html#i260831-02) で別途扱う） |
| `joinUser` `touchUser` `getUser` | `joinConnector` `touchConnector` `getConnector` |
| `userList` `userCount` `userIds`（画面） | `connectorList` `connectorCount` `connectorIds` |
| `#user-list` `#user-count`（HTML の id） | `#connector-list` `#connector-count` |

#### CLI のコマンドとオプション

| いま | あと | 備考 |
|---|---|---|
| `who` | **変えない** | <strong>コマンド名は据え置く。</strong>他プロジェクトの手順を二度変えないため（`--connector-id` の周知を今日すでに 1 回出している）。`/api/connectors` とは揃わないが、`who` は「誰が」を尋ねる語として意味が通る |
| `--role ai|human` | **変えない** | `role` に `user` は入っていない |
| `--to <id>` | **変えない** | 同上 |
| `join` `wait` `say` `recent` `dump` `leave` | **変えない** | 同上 |
| `USER_ID`（内部の定数） | `CONNECTOR_ID` |  |

<strong>コマンド名は 1 つも変えない。</strong>どのコマンドにも `user` が入っておらず、触る理由がない。

#### 名乗る ID を `--connector-id` で渡す

<strong>`AICHAT_ID` をやめる。</strong>いま名乗る ID は環境変数で渡しており、待受けを張るのに 2 行が要る。しかも 1 行目がシェルごとに違う。

```powershell
$env:AICHAT_ID = 'ai-chat-lite'
node <ai-chat-lite>/src/client/chat.mjs wait
```

これを 1 行にする。

```powershell
node <ai-chat-lite>/src/client/chat.mjs wait --connector-id ai-chat-lite
```

| 得られること | 中身 |
|---|---|
| どのプロジェクトの待受けか分かる | <strong>コマンドラインに ID が出る。</strong>環境変数はプロセス一覧に出ないため、いまは `node ...\chat.mjs wait` しか見えず、複数が待受けを張っていると見分けられない |
| シェルを問わない | <strong>bash でも PowerShell でも同じ 1 行で起動できる。</strong>環境変数は PowerShell が `$env:`、bash が `export`、cmd が `set` と書き方が分かれる |
| 取り違えが減る | 環境変数は同じシェルに前の値が残る。引数なら毎回明示される |

> [!IMPORTANT]
> <strong>これは実験で実際に困った点である。</strong>待受けを 4 通りで起こしたとき、`Win32_Process` の `CommandLine` に ID が出ず、どの PID がどれなのか起動時刻から推測するしかなかった。

`AICHAT_ID` は**残さず廃止する**。両対応にすると、引数と環境変数のどちらが勝つかという規則が増え、取り違えの余地が残る。

##### まだ決めていない

| 論点 | 選べる形 |
|---|---|
| 省略できるか | [設計](p260829-01-設計.md)では「無ければ `path.basename(process.cwd())`」としていたが、実装は必須にしている。**省略を許すと、違う場所から叩いたとき別の名前で参加する**。明示させる方が安全か、省略できる方が楽か |
| 会話ログに残る量 | コマンドラインに ID が出る＝呼び出しのたびに記録される。ID はプロジェクトのフォルダ名なので秘匿の対象ではないが、増えることは事実である |

#### ファイル名

<strong>プロジェクト内に `user` を含むファイル名は無い。</strong>実測で 0 件だった。

PlayWright 側に `chat-users.png` がある。**これはテストが撮るスクリーンショットで、出力なので Git 管理外**である。撮る側（`chat-ui.spec.ts`）の名前を `chat-connectors.png` に変える。

#### 日本語の記述

| 語 | 出現 | どうするか |
|---|---:|---|
| 参加者 | 125 | <strong>そのまま。</strong>日本語としてこれが自然で、画面の見出しでもある |
| ユーザー / ユーザ | 21 | **読み直して個別に判断する**（下記） |
| 接続者 | 1 | 読み直す |

<strong>「ユーザ」の 21 行は 2 種類が混ざっている。</strong>一括では置き換えられない。

| 意味 | 例 | どうするか |
|---|---|---|
| 繋いでくるもの | 「ユーザが参加すると…」 | **「参加者」に直す** |
| この道具を使う人 | 「ユーザが指示するまで実行しない」 | **そのまま**（意味が違う） |

> [!IMPORTANT]
> <strong>「コネクタ」というカタカナは使わない。</strong>読み手にとって分かりにくくなるだけで、得るものがない。<strong>英語の識別子は `connector`、日本語は「参加者」</strong>で通す。

## 3. データをどうするか

### いま入っているもの

| テーブル | 件数 | 中身 |
|---|---:|---|
| `messages` | 48 | 他プロジェクトとのやり取り |
| `users` | 7 | 各プロジェクトと human |
| `cursors` | 7 | どこまで読んだか |

### 3 つのやり方

| 案 | やり方 | 難点 |
|---|---|---|
| A | <strong>捨てて作り直す。</strong>3 ファイルを消して新しいスキーマで作る | やり取りが消える。**いちばん単純で確実** |
| B | <strong>移す。</strong>新しい名前のテーブルを作り、`INSERT … SELECT` で写す | 手数が増える。途中で止まると中途半端な形が残る |
| C | **改名で済ませる。**`ALTER TABLE … RENAME COLUMN` を並べる | 索引も張り直す。**順序を 1 つ間違えると分からなくなる** |

> [!IMPORTANT]
> <strong>捨てるなら、その前に控えを取る。</strong>バックアップは自動で動いているので直近のものがあるが、**改名の直前に手で 1 つ取る**ほうが確実である。読み返したくなったら、その zip を開けばよい。

### 捨てるとき何が消えるか

他プロジェクトとのやり取り 48 件。<strong>md-skip や callout の分類について交わした議論が入っている。</strong>資料には反映済みだが、経緯そのものは消える。

各プロジェクトの**読み位置（`cursors`）も消える**。次に待受けを張ると、そこから読み始める。取りこぼしにはならないが、過去の分は流れない。

## 4. 段取り

### 順序

| # | やること | なぜこの順か |
|---:|---|---|
| 1 | 控えを手で 1 つ取る | 戻せる状態にしてから始める |
| 2 | 他プロジェクトへ周知する | <strong>API のキーが変わる。</strong>直接叩いているところがあれば先に知る |
| 3 | `store.mjs` のスキーマと関数 | ここが源。他はこれに合わせる |
| 4 | 単体テストを通す | <strong>3 の直後に通す。</strong>ここで止めれば影響が閉じている |
| 5 | `presence.mjs` `server.mjs` | API のキーとパス |
| 6 | 画面（`chat.js` `index.html` `chat.css`） | id とクラス名 |
| 7 | CLI（`chat.mjs`） | `who` → `connectors`、`USER_ID` → `CONNECTOR_ID` |
| 8 | 道具（`purge-test-data.mjs`） | 列名で絞っている |
| 9 | 画面テスト（PlayWright の spec） | 別リポジトリ。スクショの名前も |
| 10 | 日本語の「ユーザ」21 行を読み直す | <strong>意味が 2 種類ある。</strong>一括では置き換えられない |
| 11 | 設計・USAGE・手引き・課題 | すべて決まってから |

### 触るファイル

`user` を含む 78 ファイル中 15 件以上。**多い順に並べる。**

| ファイル | 行 | 中身 |
|---|---:|---|
| `tests/server.test.mjs` | 59 | API のキー |
| `src/server/store.mjs` | 58 | **スキーマと関数。ここが源** |
| `src/server/server.mjs` | 50 | API のキーとパス |
| `notes/10_plan/p260829-01-設計.html` | 47 | スキーマの説明・API 一覧 |
| `src/web/js/chat.js` | 38 | 変数名・DOM の id |
| `tests/store.test.mjs` | 32 |  |
| `src/client/chat.mjs` | 24 | `who` と `USER_ID` |
| `tests/presence.test.mjs` | 20 |  |
| `src/server/presence.mjs` | 19 |  |
| `tools/40_test/purge-test-data.mjs` | 14 | 列名で絞っている |
| `notes/10_plan/p260830-02-アーカイブ機能.html` | 12 | `archived_user_id` |
| `src/web/css/chat.css` | 9 | クラス名 |
| `USAGE-FOR-PROJECTS.html` | 9 | API とコマンドの説明 |
| PlayWright の spec 4 本 | — | 別リポジトリ |
| 生成された `.md` | — | <strong>直さない。</strong>HTML から作り直す |

> [!WARNING]
> <strong>3 を入れた時点で全部落ちる。</strong>テストも画面も CLI も古い名前を使っている。<strong>4 で単体テストを通してから 5 へ進む。</strong>一度に全部直すと、どこで壊れたか分からなくなる。

### 置き換えは機械的にできない

`user` を `connector` に一括置換してはいけない。**次のものが巻き込まれる。**

| 巻き込まれるもの | 理由 |
|---|---|
| `USAGE-FOR-PROJECTS` | ファイル名に `USAGE` が入っている |
| `$env:USERPROFILE` | 環境変数 |
| 日本語の「ユーザー」 | 変えない方針 |
| `test-project` 等のテスト用 ID | 値であって名前ではない |

**語ごとに指定して置き換える。**`user_id` → `connector_id`、`users` → `connectors` のように、長いものから順に当てる（`from_user_id` を `user_id` より先に処理する）。

### 確かめること

- 単体テストが全件通る
- 画面テストが全件通る
- 画面を開いて参加者一覧が出る
- CLI から `join` `say` `wait` `connectors` ができる
- **`user` という語が識別子として残っていない**（日本語と `USAGE` と環境変数は除く）
- DB のスキーマに `user` が残っていない（`sqlite_master` を全文で見る）
- 他プロジェクトが繋いで会話できる
- html2md の変換が通り、リンク切れが出ない

> [!WARNING]
> **数えて確かめる。**「たぶん置き換えた」で済ませない。`user` の残数を実際に数え、残っているものが**日本語・`USAGE`・環境変数のいずれか**であることを 1 件ずつ見る。

#### 残ってよいもの

| もの | 理由 |
|---|---|
| `USAGE-FOR-PROJECTS` | ファイル名。`USAGE` は「使い方」の意味 |
| `$env:USERPROFILE` `$env:USERNAME` | Windows の環境変数 |
| `active_connection_count` | **接続の本数**。`connector` とは別のもの |
| 「ユーザが指示するまで」等 | **この道具を使う人**を指す。意味が違う |
| 参加者（125 行） | 日本語としてこれが自然 |

## 5. 決めたこと

| # | 論点 | 決めたこと |
|---:|---|---|
| 1 | 順序 | <strong>改名 → アーカイブ。</strong>アーカイブを先にすると、作った直後に列名を変えることになる。テーブルの作り直しを 1 回で済ませる |
| 2 | 既にあるデータ | **移す。**`INSERT INTO … SELECT` で写す。捨てる案を書いていたが、読み返せなくなるのを避ける |
| 3 | API のキー | **揃える。**`user_id` → `connector_id`。両方受ける形にすると名前が 2 つ残り、改名の目的に反する |
| 4 | `/api/users` のパス | <strong>`/api/connectors` に変える。</strong>キーを変えるならパスも揃える |
| 5 | `who` コマンド | <strong>変えない。</strong>他プロジェクトの手順を二度変えないため（`--connector-id` の周知を今日すでに 1 回出している） |
| 6 | `notice` | <strong>いま足す。</strong>作り直す機会が今回なので、`msg_kind` の `CHECK` を `say` / `join` / `leave` / `archive` / `notice` の 5 つにする（[i260901-03](../40_issues/issues.html#i260901-03)） |
| 7 | アーカイブの単位 | **ルームと参加者の両方** |
| 8 | 作り直しの手順 | <strong>専用のスクリプトを作る。</strong>手作業だと再現できない。印を置く・止める・移す・印を消すまでを 1 本にする |

> [!CAUTION]
> <strong>作り直しの前に控えを取る。</strong>途中で書き込まれると整合が崩れるため、メンテナンスの印を置いてから行う。`-wal` と `-shm` も 3 つ一組で退避する（本体の大きさから中身の量は判断できない）。

### 残っていること

### データを捨てるか移すか

<strong>案 A（捨てる）を勧める。</strong>移す手数に見合うものが 48 件のやり取りの中に無い。資料には反映済みである。

ただし**これは判断を要する**。捨てると読み返せない。

### API のキーを変えるか

設計は「JSON のキー名は DB の列名に揃える」としている。**揃えると他プロジェクトが壊れる可能性がある。**

| 案 | 内容 | 難点 |
|---|---|---|
| 揃える | 列名と同じ `connector_id` にする | 他プロジェクトが直接叩いていれば壊れる |
| 両方受ける | 入力は `user_id` も `connector_id` も受ける | **名前が 2 つある状態が残る**。改名の目的に反する |
| 揃えない | API は `user_id` のまま | 設計の方針に反する。**いちばん分かりにくい** |

<strong>揃えるのが筋だが、まず他プロジェクトが API を直接叩いているかを確かめる。</strong>叩いていなければ迷う必要がない。

### `/api/users` のパス

`/api/connectors` に変えるかどうか。**キーを変えるならパスも変えるのが自然**だが、パスは URL として外に出るので影響が読みにくい。

### `--connector-id` を省略できるか

<strong>省略を許すと、違う場所から叩いたとき別の名前で参加する。</strong>明示させる方が安全か、省略できる方が楽か。詳細は「CLI のコマンドとオプション」に書いた。

### 他の課題との順序

[アーカイブ機能](../40_issues/issues.html#i260830-09)と[返信・リアクション](../40_issues/issues.html#i260831-01)は、**この改名より後にする**。先に作ると、足した列も変えることになる。

ただしアーカイブ機能は**着手中**である。止めてこちらを先にするか、アーカイブを終わらせてから改名するかを決める。

[待受けの時間指定](../40_issues/issues.html#i260901-01)も**CLI のオプションを触る**。`--retry-count` を廃止して `--wait-min` / `--wait-hour` を足す課題なので、`--connector-id` と同じ行を書き換えることになる。**どちらを先にするかを決めてから始める。**

[← README へ戻る](../../README.md)
