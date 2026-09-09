/**
 * CLI のオプションとコマンドの定義。
 *
 * ここが唯一の置き場になる。usage() の表示もこの表から組み立てるため、
 * 定義を増やせば表示にも出る。手で 2 か所に書いていた頃は必ずずれた
 * （実際に --retry-count が usage() から抜けていた）。
 *
 * chat.mjs から分けてあるのは、テストが実行せずに読めるようにするため。
 * chat.mjs はトップレベルでコマンドを走らせる作りなので import できない。
 */

/**
 * 待つ長さの単位。単位ごとに 1 つのオプションを持つ。
 *
 * 名前に単位を入れるのは、値だけを見て取り違えないようにするため。
 * --wait 480 と書けたとしても、それが分か秒かは定義を読まないと分からない。
 */
export const WAIT_UNITS = [
	{ long: 'wait-hour', sec: 3600 },
	{ long: 'wait-min', sec: 60 },
	{ long: 'wait-sec', sec: 1 },
];

/**
 * 何も指定しないときに待つ長さ。
 *
 * 待受けは張りっぱなしにするものなので、長い方に倒す。前面で呼ぶと
 * 途中で背面に移されるが、プロセスは走り続けるので実害はない。
 *
 * 12 時間にしてある。Claude Code はサブエージェントが持つ背面のコマンドを
 * 既定で 60 分で止めるため、それより長い値はどれも「途中で終わる」。
 * 上限を伸ばしている環境（CLAUDE_SUBAGENT_BG_SHELL_MAX_MS）では、
 * この値まで走る。
 *
 * 上限を伸ばしていなくても困らない。終わったら張り直すだけで、読んだ位置は
 * サーバーが覚えているので取りこぼさない。長さに頼る作りにはしていない。
 */
export const DEFAULT_WAIT_SEC = 12 * 3600;

/**
 * 名乗る ID を囲む記号。コマンドの直後に :自分の ID: の形で置く。
 *
 * 囲むのは、ID どうしの前方一致を止めるため。囲みが無いと project-a を探す式が
 * project-aa にも当たり、1 本しか張っていない待受けが 2 本に見える。それを
 * 二重と誤認して片方を止めると、相手は原因不明の exit 255 で落ちる（実際に起きた）。
 * 閉じの記号が境目になるので、囲めば起きない。
 *
 * コロンにしたのは、PowerShell・bash・cmd の 3 つで素のまま打てて、かつ
 * PowerShell の -like にもそのまま入れられる記号がこれだったため。
 *
 *   [id]  bash でファイル名の型として読まれ、別物に化ける（エラーは出ない）。
 *         PowerShell の -like でも文字クラスとして扱われ、落ちるか黙って誤一致する
 *   {id}  PowerShell がスクリプトブロックとして読む
 *   <id>  cmd でリダイレクトになる
 *   #id#  PowerShell と bash でコメントになる
 *   _id_  ID にも使える文字なので、囲みの境目が読み取れない
 *
 * 囲みはコマンドラインの書き方であって、値の一部ではない。引数を読んだ直後に
 * 剥がし、以降は裸の ID だけを扱う。API へ送る値・ログ・画面はすべて裸にする。
 */
export const ID_WRAP = ':';

/**
 * ID に使える文字。英数字・ハイフン・下線・ピリオドだけ。
 *
 * 正規表現ではなく文字列で持つのは、この定義を JSON に書き出して C# 版に
 * 埋め込むため。2 本の CLI とサーバーが同じ規則を見るようにする。
 *
 * 記号と空白を断るのは、囲みの記号と紛れないようにするためと、
 * コマンドラインで語が割れないようにするため。
 *
 * ピリオドは先頭・末尾に置けない。Windows はファイル名の末尾のピリオドを
 * 落とすため（待受けのログが logs/client/yyyymmdd-hhmmss-<ID>.log に入る）、
 * 末尾に許すと名前が食い違う。先頭も禁じ、"." "-" のような 1 文字だけの
 * ID と見分けやすくする。1 文字だけの ID（ピリオド以外）はそのまま許す。
 */
export const ID_PATTERN = '^[A-Za-z0-9_-](?:[A-Za-z0-9_.-]*[A-Za-z0-9_-])?$';

/**
 * コマンドラインから待受けを見つける式。1 つめか 2 つめの括弧に ID が入る。
 *
 * wait の後ろに空白を要求するのが要点。これが無いと waiters 自身に一致し、
 * 数えているコマンドが数に入る。
 *
 * 古い形（-c / --connector-id）も拾う。切り替えの途中は新旧が混ざるため、
 * 片方しか見ないと相手の待受けを見落として二重に張らせてしまう。
 *
 * 2 本の CLI が同じ式を使う。JavaScript と .NET でこの書き方は同じ意味になる。
 */
export const WAITER_PATTERN = '(?:^|\\s)wait\\s+(?::([A-Za-z0-9_.-]+):|(?:-c|--connector-id)\\s+([^\\s"]+))';

/**
 * 【決めごと】接続先（--url / --port）は既定値を持たない。
 *
 * どのコマンドでも省略できない。環境変数も見ない。指定が無ければエラーで止める。
 * これから足すコマンドでも守る。
 *
 * 既定を本番のポートにすると、テストのつもりで叩いたものが本番に入る。
 * 実際にそれが起きた。書き込まないコマンド（waiters）でも同じで、既定を本番に
 * すると「テストのつもりで数えた本数」を本番の本数として読み違える。
 * 「張っているから張らない」と判断して、本番の待受けが 1 本も無いまま止まる。
 *
 * ルーム（--room）は例外で、既定を public にしている。参加の行き先が 1 つに
 * 決まっていないと、そもそも会話が始まらないため。
 *
 * 名乗る ID も既定値を持たない。理由は ID_WRAP の項を見ること。
 */

/**
 * オプションの定義。
 *
 * long  … --名前 で渡す形
 * short … -x で渡す形。持たないものは null
 * arg   … 値の見出し
 * cmd   … そのコマンドだけのもの。null はどのコマンドにも付けられる
 * desc  … 説明
 *
 * 短い形は全部には付けない。よく打つものだけに付け、頭文字がぶつかるもの
 * （--room と --role、--wait-min と --wait-hour）は片方だけにする。
 */
export const OPTIONS = [
	{ long: 'help', short: 'h', arg: '', cmd: null, desc: 'この使い方を出す。コマンドを付けなくても出る' },
	{ long: 'with-messages', short: null, arg: '', cmd: 'archive', desc: '参加者を片付けるとき、その参加者の発言も含める' },
	{ long: 'description', short: null, arg: '<説明>', cmd: 'archive', desc: '何をなぜ片付けたか。省略すると自動で組み立てる' },
	{ long: 'port', short: 'p', arg: '<ポート>', cmd: null, desc: 'localhost のポートだけを変える' },
	{ long: 'url', short: 'u', arg: '<URL>', cmd: null, desc: '接続先。ホストごと変える（--port とは併用できない）' },
	{ long: 'room', short: 'r', arg: '<id[,id]>', cmd: null, desc: 'ルームを変える。カンマ区切りは wait と waiters だけ' },
	{ long: 'access-token', short: 'a', arg: '<値>', cmd: null, desc: 'サーバーから求められたときに渡す。ふだんは要らない' },
	{ long: 'role', short: null, arg: 'ai|human', cmd: 'join', desc: '参加するときの区分' },
	{ long: 'wait-hour', short: 'w', arg: '<時間>', cmd: 'wait', desc: '最大どれだけ待つか（時）。0 で上限なし' },
	{ long: 'wait-min', short: null, arg: '<分>', cmd: 'wait', desc: '同じ意味を分で（併用できない）' },
	{ long: 'wait-sec', short: null, arg: '<秒>', cmd: 'wait', desc: '同じ意味を秒で。確認用' },
	{ long: 'with-joins', short: null, arg: '', cmd: 'wait', desc: '参加・離脱でも起こす。既定では起こさない' },
	{ long: 'to', short: null, arg: ':<id>:', cmd: 'say', desc: '名指しの相手。ID はコロンで囲む' },
	{ long: 'reply-to', short: null, arg: '<msg_seq>', cmd: 'say', desc: 'どの発言への返答か。番号は出力の # を見る' },
	{ long: 'n', short: 'n', arg: '<件数>', cmd: 'recent', desc: '直近の履歴を何件出すか' },
	{ long: 'since', short: null, arg: '<日時>', cmd: 'recent', desc: 'この日時以降。書式は --help を参照' },
	{ long: 'since-day', short: null, arg: '<N>', cmd: 'recent', desc: 'N 日前以降（--since / --since-hour とは併用不可）' },
	{ long: 'since-hour', short: null, arg: '<N>', cmd: 'recent', desc: 'N 時間前以降（--since / --since-day とは併用不可）' },
	{ long: 'before', short: null, arg: '<日時>', cmd: 'recent', desc: 'この日時より前。--since と同じ書式・同じ丸め' },
	{ long: 'find', short: null, arg: '<文字列>', cmd: 'recent', desc: '本文にこの文字列を含むものだけ' },
	{ long: 'from', short: null, arg: '<id>', cmd: 'recent', desc: 'この ID からの発言だけ（コロンは有っても無くてもよい）' },
	{ long: 'out', short: null, arg: '<path>', cmd: 'dump', desc: 'JSONL の書き出し先' },
];

/**
 * コマンドの定義。
 *
 * :<id>: が付いているものは、名乗る ID をコマンドの直後に置く。読むだけの
 * コマンド（recent / who / dump / archives）は名乗る必要がないので取らない。
 */
export const COMMANDS = [
	{ name: 'join', arg: ':<id>:', desc: '参加登録する' },
	{ name: 'wait', arg: ':<id>:', desc: `新着を待つ。届いたら出して終わる（既定 ${DEFAULT_WAIT_SEC / 3600} 時間）` },
	{ name: 'say', arg: ':<id>: "本文"', desc: '投稿する' },
	{ name: 'recent', arg: '', desc: '直近の履歴を出す' },
	{ name: 'who', arg: '', desc: '参加者と状態を出す' },
	{ name: 'waiters', arg: ':<id>:', offline: true, desc: '待受けが何本走っているかを数える。サーバーには繋がない' },
	{ name: 'dump', arg: '', desc: '全ルームの発言を JSONL に書き出す（片付けたものも含む）' },
	{ name: 'leave', arg: ':<id>:', desc: '離脱を知らせる' },
	{ name: 'archive', arg: ':<id>: <種別> <対象>', desc: '片付ける。種別は message / connector / room。先に件数を出し、対象名の入力を求める' },
	{ name: 'archives', arg: '', desc: '片付けたものの一覧を出す' },
	{ name: 'restore', arg: ':<id>: <archived_seq>', desc: '片付けたものをまとめて戻す' },
];

/**
 * 繋がらないときに、どれだけ粘るか。
 *
 * 間隔は 10 秒。値はハードコードする。呼ぶ側が決めることではない。
 *
 * コマンドで 3 段に分ける。call() は全コマンドで共通なので、一律に長くすると
 * 人が打つ say や who がその間ずっと固まる。
 *
 *   wait          … どうせ待つのが仕事。長く粘ると張り直しの手間が減る
 *   restart / stop … 止めに行くコマンドが繋がらない＝すでに止まっている
 *   それ以外       … 人が打つ。返事が来ないと判断できない
 */
export const RETRY_INTERVAL_SEC = 10;

export const RETRY_TIMES = {
	wait: 60, // 10 分
	restart: 0,
	stop: 0,
	default: 6, // 60 秒
};

/**
 * 終了コード。
 *
 *   1 … 一般のエラー
 *   2 … 使い方の誤り
 *   3 … 繋がらない（サーバーの都合）
 *
 * 3 を分けているのは、呼ぶ側が「自分の書き方が悪い」のか「向こうが止まっている」
 * のかを区別できるようにするため。
 */
export const EXIT_UNREACHABLE = 3;

/**
 * 値を取らないオプション（旗）。
 *
 * 位置引数を拾うときに値を飛ばしてはいけない。飛ばすと archive room sandbox の
 * sandbox が消える。
 */
export const FLAGS = new Set(
	OPTIONS.filter((o) => o.arg === '').flatMap((o) => (o.short ? [`--${o.long}`, `-${o.short}`] : [`--${o.long}`]))
);

/** サーバーを操作するコマンド。管理者権限は要らない */
export const ADMIN_COMMANDS = [
	{ name: 'restart', arg: ':<id>:', desc: '落として起動し直させる（ソース修正の反映に使う）' },
	{ name: 'stop', arg: ':<id>:', desc: '止める。起動し直すには winsw の start が要る' },
];

/**
 * 廃止したオプション。渡されたら黙って無視せずエラーで止める。
 *
 * 他プロジェクトの手順書やルールに古い形が残っている。無視すると
 * 「指定したつもりの待ち時間が効かない」まま動き、気づけない。
 *
 * short を持つのは、短い形でも捕まえるため。--connector-id を長い形だけ見て
 * いると、-c で叩いた相手が「知らないオプションです」で止まり、直し方が
 * 分からない。廃止したものほど、名指しで案内する値がある。
 */
export const REMOVED = new Map([
	['timeout', { short: null, hint: '1 回の待ち時間は指定しません。--wait-hour / --wait-min / --wait-sec で全体の長さを指定してください' }],
	['retry-count', { short: null, hint: '回数の指定はなくなりました。--wait-hour / --wait-min / --wait-sec で全体の長さを指定してください' }],
	['connector-id', { short: 'c', hint: '名乗る ID はコマンドの直後に、コロンで囲んで置きます。例: wait :ai-chat-lite: -p 8787' }],
]);
