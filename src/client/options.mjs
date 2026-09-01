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
 */
export const DEFAULT_WAIT_SEC = 8 * 3600;

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
	{ long: 'connector-id', short: 'c', arg: '<id>', cmd: null, desc: '名乗る ID。読むだけのコマンド以外では省略できない' },
	{ long: 'port', short: 'p', arg: '<ポート>', cmd: null, desc: 'localhost のポートだけを変える' },
	{ long: 'url', short: 'u', arg: '<URL>', cmd: null, desc: '接続先。ホストごと変える（--port とは併用できない）' },
	{ long: 'room', short: 'r', arg: '<id>', cmd: null, desc: 'ルームを変える' },
	{ long: 'access-token', short: 'a', arg: '<値>', cmd: null, desc: 'テスト用のサーバーへ繋ぐときだけ要る。本番では要らない' },
	{ long: 'role', short: null, arg: 'ai|human', cmd: 'join', desc: '参加するときの区分' },
	{ long: 'wait-hour', short: 'w', arg: '<時間>', cmd: 'wait', desc: '最大どれだけ待つか（時）。0 で上限なし' },
	{ long: 'wait-min', short: null, arg: '<分>', cmd: 'wait', desc: '同じ意味を分で（併用できない）' },
	{ long: 'wait-sec', short: null, arg: '<秒>', cmd: 'wait', desc: '同じ意味を秒で。確認用' },
	{ long: 'to', short: null, arg: '<id>', cmd: 'say', desc: '名指しの相手' },
	{ long: 'n', short: 'n', arg: '<件数>', cmd: 'recent', desc: '直近の履歴を何件出すか' },
	{ long: 'out', short: null, arg: '<path>', cmd: 'dump', desc: 'JSONL の書き出し先' },
];

/** コマンドの定義 */
export const COMMANDS = [
	{ name: 'join', arg: '', desc: '参加登録する' },
	{ name: 'wait', arg: '', desc: `新着を待つ。届いたら出して終わる（既定 ${DEFAULT_WAIT_SEC / 3600} 時間）` },
	{ name: 'say', arg: '"本文"', desc: '投稿する' },
	{ name: 'recent', arg: '', desc: '直近の履歴を出す' },
	{ name: 'who', arg: '', desc: '参加者と状態を出す' },
	{ name: 'dump', arg: '', desc: '全ルームの発言を JSONL に書き出す（片付けたものも含む）' },
	{ name: 'leave', arg: '', desc: '離脱を知らせる' },
	{ name: 'archive', arg: 'message|connector|room <対象>', desc: '片付ける。先に件数を出し、対象名の入力を求める' },
	{ name: 'archives', arg: '', desc: '片付けたものの一覧を出す' },
	{ name: 'restore', arg: '<archived_seq>', desc: '片付けたものをまとめて戻す' },
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
	{ name: 'restart', arg: '', desc: '落として起動し直させる（ソース修正の反映に使う）' },
	{ name: 'stop', arg: '', desc: '止める。起動し直すには winsw の start が要る' },
];

/**
 * 廃止したオプション。渡されたら黙って無視せずエラーで止める。
 *
 * 他プロジェクトの手順書やルールに古い形が残っている。無視すると
 * 「指定したつもりの待ち時間が効かない」まま動き、気づけない。
 */
export const REMOVED = new Map([
	['timeout', '1 回の待ち時間は指定しません。--wait-hour / --wait-min / --wait-sec で全体の長さを指定してください'],
	['retry-count', '回数の指定はなくなりました。--wait-hour / --wait-min / --wait-sec で全体の長さを指定してください'],
]);
