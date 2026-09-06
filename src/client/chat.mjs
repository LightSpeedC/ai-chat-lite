import { basename, join } from 'node:path';
import { writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

import { ROOT, PORT, DEFAULT_ROOM, MAX_WAIT_SEC, IS_TEST } from '../server/config.mjs';
import { nowJst } from '../server/time.mjs';
import {
	WAIT_UNITS,
	DEFAULT_WAIT_SEC,
	ID_WRAP,
	ID_PATTERN,
	WAITER_PATTERN,
	OPTIONS,
	COMMANDS,
	ADMIN_COMMANDS,
	REMOVED,
	RETRY_INTERVAL_SEC,
	RETRY_TIMES,
	EXIT_UNREACHABLE,
	FLAGS,
} from './options.mjs';

/**
 * ai-chat-lite の CLI クライアント。
 *
 * AI セッションと人間の両方が同じものを使う。DB は触らず、すべて HTTP 越しに行う。
 * wait は「1 回待って、結果を出して終わる」形にしてあり、自分ではループしない。
 * そのままサブエージェントに渡せるようにするため。
 */

/** ID を使わないコマンド。読むだけなので名乗る必要がない */
const READ_ONLY = new Set(['recent', 'who', 'dump', 'archives']);

const STATUS_MARK = { online: '●', grace: '◐', offline: '○' };

/**
 * 前面のツール実行が背面に移されるまでの秒数。
 *
 * 打ち切られるのではない。プロセスはそのまま走り続ける。
 * ただしそれまで呼び出し側が待たされるため、これを超える設定には警告を出す。
 */
const FOREGROUND_SEC = 600;

// --- 引数 ---

const [, , command, ...rest] = process.argv;

/**
 * コマンドを含めた引数の全体。
 *
 * 値を取らない旗（--help）と廃止したオプションは、ここを見る。
 * `chat.mjs -h` のように旗を先頭に置くと command 側に入り、rest には来ない。
 */
const WORDS = process.argv.slice(2);

/** 長い名前から短い名前を引く。定義に無い名前を渡したら気づけるよう、引く側で例外にする */
const SHORT_OF = new Map(OPTIONS.map((o) => [o.long, o.short]));

for (const [name, { short, hint }] of REMOVED) {
	const given = WORDS.includes(`--${name}`) ? `--${name}` : short && WORDS.includes(`-${short}`) ? `-${short}` : null;
	if (given) {
		console.error(`${given} は廃止されました。`);
		console.error(`  ${hint}`);
		process.exit(2);
	}
}

/**
 * --name value 形式のオプションを取り出す。短い形（-x）も同じ値として受ける。
 *
 * 長い形を先に見る。両方書かれたときは長い形が勝つ。
 */
function option(name, fallback = null) {
	if (!SHORT_OF.has(name)) throw new Error(`OPTIONS に無いオプションです: ${name}`);
	const short = SHORT_OF.get(name);
	const flags = short ? [`--${name}`, `-${short}`] : [`--${name}`];
	for (const flag of flags) {
		const i = rest.indexOf(flag);
		if (i >= 0 && rest[i + 1] !== undefined) return rest[i + 1];
	}
	return fallback;
}

/**
 * 値を取らないオプション（--help など）が渡されたかを見る。
 *
 * option() は「次の引数が値」という前提なので、旗として使うものはこちらで見る。
 */
function hasFlag(name) {
	if (!SHORT_OF.has(name)) throw new Error(`OPTIONS に無いオプションです: ${name}`);
	const short = SHORT_OF.get(name);
	return WORDS.includes(`--${name}`) || (short ? WORDS.includes(`-${short}`) : false);
}

/**
 * 接続先を決める。
 *
 * --url はホストごと、--port は localhost のポートだけを変える。
 * 同じことを 2 通りで書けるため、両方あればエラーにする。片方を黙って
 * 優先すると、書いたつもりの側が効かずに気づけない。
 *
 * 既定値を持たない。環境変数も見ない。指定が無ければ null を返し、
 * 繋ぐ直前にエラーで止める。既定を本番のポートにすると、
 * テストのつもりで叩いたものが本番に入る。実際にそれが起きた。
 *
 * ここで止めずに null を返すのは、--help を接続先なしで出せるようにするため。
 */
function resolveBase() {
	const url = option('url');
	const port = option('port');
	if (url !== null && port !== null) {
		console.error('--url と --port は同時に指定できません。どちらか一方にしてください。');
		process.exit(2);
	}
	if (url !== null) return url.replace(/\/+$/, '');
	if (port !== null) {
		if (!/^\d+$/.test(port)) {
			console.error(`--port には数だけを渡してください: ${port}`);
			process.exit(2);
		}
		return `http://localhost:${port}`;
	}
	return null;
}

const BASE = resolveBase();

/**
 * 名乗る ID を渡す場所。コマンドの直後の位置引数に固定する。
 *
 * オプション（--connector-id / -c）は廃止した。オプションはコマンドの前にも
 * 後ろにも書けるため、プロセス一覧から待受けを探すときに並びが定まらない。
 * コマンドの次の語に固定すれば、探す側が場所を決め打ちできる。
 *
 * 自動で決めない。既定値も持たず、カレントのフォルダ名からも採らない。
 * 取り違えた名前で名乗ると connectors とログに残り、後から消せない。
 * 実際に ID は project フォルダ名と一致しないものが使われている（agent-rules、
 * human）。一致を前提にした実装は取り違える。
 *
 * 環境変数でも受けない。環境変数はプロセス一覧に出ないため、動いている
 * 待受けがどのプロジェクトのものか分からなくなる。
 */
const READ_ONLY_COMMAND = READ_ONLY.has(command);

/** 位置引数の全体。名乗る ID もここに入る */
const ARGS = positionals();

/**
 * 名乗る ID を除いた位置引数。本文・対象・番号はここから取る。
 *
 * 読むだけのコマンドは ID を取らないので、そのまま全部が中身になる。
 */
const TAIL = READ_ONLY_COMMAND ? ARGS : ARGS.slice(1);

let CONNECTOR_ID = null;

/**
 * :id: の囲みを剥がして中身を返す。形が違えば止める。
 *
 * 囲みが無いものを黙って受けると、新しい形と古い形が混ざる。混ざると
 * 「コマンドの次の語が ID」という前提が崩れ、探す側が場所を決め打ちできない。
 * それが廃止の目的そのものなので、ここは緩めない。
 */
function unwrapId(raw, where) {
	const w = ID_WRAP;
	if (raw.length > w.length * 2 && raw.startsWith(w) && raw.endsWith(w)) {
		const id = raw.slice(w.length, -w.length);
		if (new RegExp(ID_PATTERN).test(id)) return id;

		console.error(`ID に使えない文字が入っています（${where}）: ${raw}`);
		console.error('  使えるのは英数字・ハイフン・下線だけです。');
		process.exit(2);
	}

	console.error(`ID は ${w} で囲んでください（${where}）: ${raw}`);
	console.error(`  例: ${w}${raw.replaceAll(w, '')}${w}`);
	process.exit(2);
}

function requireConnectorId() {
	if (CONNECTOR_ID) return CONNECTOR_ID;

	const raw = ARGS[0] ?? null;
	if (raw === null) {
		console.error('名乗る ID が指定されていません。');
		console.error('');
		console.error(`  ${command} の直後に、コロンで囲んで置いてください:`);
		console.error(`    ${command} ${ID_WRAP}${basename(process.cwd())}${ID_WRAP}`);
		console.error('');
		console.error('  自分の project フォルダ名にしておくと、誰の発言か分かりやすくなります。');
		process.exit(1);
	}

	CONNECTOR_ID = unwrapId(raw, `${command} の直後`);
	return CONNECTOR_ID;
}

/** 繋ぐ前に接続先を確かめる。既定値を持たないので、指定が無ければここで止まる */
function requireBase() {
	if (BASE) return BASE;
	console.error('接続先が指定されていません。--port <ポート> か --url <URL> を渡してください。');
	console.error(`  本番: --port ${PORT}`);
	console.error('  テスト用: 置き場の server.json の port を使う');
	process.exit(2);
}

/**
 * 最大どれだけ待つかを秒で返す。0 は上限なし。
 *
 * 単位ごとにオプションを持つので、2 つ以上あればエラーにする。足したり
 * 後勝ちにしたりすると、書いたつもりの側が効かずに気づけない。
 *
 * `Number(x) || 既定値` と書いてはいけない。0 は falsy なので、
 * 「上限なし」と書いたつもりが既定の 12 時間に化ける。
 */
function resolveWaitSec() {
	const given = WAIT_UNITS.map((u) => ({ ...u, raw: option(u.long) })).filter((u) => u.raw !== null);

	if (given.length > 1) {
		const names = given.map((u) => `--${u.long}`).join(' と ');
		console.error(`待つ長さは 1 つだけ指定してください: ${names} が両方あります。`);
		process.exit(2);
	}
	if (given.length === 0) return { sec: DEFAULT_WAIT_SEC, fromDefault: true };

	const [u] = given;
	if (!/^\d+$/.test(u.raw)) {
		console.error(`--${u.long} には 0 以上の数だけを渡してください: ${u.raw}`);
		process.exit(2);
	}
	return { sec: Number(u.raw) * u.sec, fromDefault: false };
}

/** 待つ長さを人が読む形にする。0 は上限なし */
function describeWait(sec) {
	if (sec === 0) return '上限なし';
	if (sec % 3600 === 0) return `${sec / 3600} 時間`;
	if (sec % 60 === 0) return `${sec / 60} 分`;
	return `${sec} 秒`;
}

/** オプションでない最初の引数（本文など） */
function positionals() {
	const args = [];
	for (let i = 0; i < rest.length; i++) {
		if (rest[i].startsWith('--') || rest[i].startsWith('-')) {
			// 旗（値を取らないもの）は値を飛ばさない。飛ばすと次の位置引数が消える
			if (!FLAGS.has(rest[i])) i++;
			continue;
		}
		args.push(rest[i]);
	}
	return args;
}

/** 名乗る ID を除いた最初の位置引数（本文・戻す番号など） */
function positional() {
	return TAIL[0] ?? null;
}

/** --to のように、値が ID のオプションを読む。囲みを剥がして返す */
function optionalWrappedId(name) {
	const raw = option(name);
	return raw === null ? null : unwrapId(raw, `--${name}`);
}

/**
 * --reply-to の値を読む。渡されなければ null。
 *
 * 先頭の # は落とす。出力には #474 と出るので、画面から写した人が
 * そのまま貼っても通るようにする。# は表示のためのもので、値の一部ではない。
 */
function replyToMsgSeq() {
	const raw = option('reply-to');
	if (raw === null) return null;

	const value = raw.replace(/^#/, '');
	if (!/^\d+$/.test(value) || Number(value) < 1) {
		console.error(`--reply-to には 1 以上の数を渡してください: ${raw}`);
		console.error('  番号は出力の先頭に #474 の形で出ています。');
		process.exit(2);
	}
	return Number(value);
}

const ROOM = option('room', DEFAULT_ROOM);

// --- 通信 ---

/*
 * テスト用のサーバーへ繋ぐためのアクセストークン。
 *
 * テスト環境はアクセストークンを持たない相手を断る。他プロジェクトが誤って
 * テスト環境へ繋いでも、テスト中のデータに混ざらないようにするため。
 *
 * 値は起動のたびに変わり、テスト用サーバーの置き場の server.json に書かれる。
 * それを読まないと分からないので、知らない相手は繋げない。
 *
 * 引数で渡す。環境変数にしないのは、口を増やさないため。
 * 本番では要らないので、渡さなければ何も付かない。
 */
const ACCESS_TOKEN = option('access-token', '');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** このコマンドが繋ぎ直す回数 */
const retryTimes = RETRY_TIMES[command] ?? RETRY_TIMES.default;

/**
 * サーバーを呼ぶ。繋がらないときと、メンテナンス中（503）のときは繋ぎ直す。
 *
 * 出すのは始めの 1 行と、諦めたときの 1 行だけ。黙ると固まったように見えるが、
 * 60 回すべて出すと 60 行になる。
 */
async function call(path, init) {
	const base = requireBase();
	const headers = { ...(init?.headers ?? {}) };
	if (ACCESS_TOKEN) headers['X-AiChat-Access-Token'] = ACCESS_TOKEN;

	let announced = false;
	let lastReason = '';

	for (let attempt = 0; attempt <= retryTimes; attempt++) {
		if (attempt > 0) await sleep(RETRY_INTERVAL_SEC * 1000);

		let res;
		try {
			res = await fetch(base + path, { ...init, headers });
		} catch (err) {
			lastReason = `繋がりません（${err?.cause?.code ?? err?.message ?? err}）`;
			if (!announced && retryTimes > 0) {
				console.error(`サーバーに繋がりません: ${base}`);
				console.error(`  ${describeRetry()}繋ぎ直します`);
				announced = true;
			}
			continue;
		}

		const json = await res.json().catch(() => ({}));

		// メンテナンス中。落ちているのではないので、同じように粘る
		if (res.status === 503) {
			lastReason = `メンテナンス中です（${json.detail ?? '理由の記載なし'}）`;
			if (!announced && retryTimes > 0) {
				console.error(`メンテナンス中です: ${json.detail ?? '理由の記載なし'}`);
				console.error(`  ${describeRetry()}繋ぎ直します`);
				announced = true;
			}
			continue;
		}

		if (!res.ok) {
			console.error(`エラー (${res.status}): ${json.error ?? '不明'}`);
			if (json.detail) console.error(`  ${json.detail}`);
			process.exit(1);
		}
		return json;
	}

	console.error(`諦めました: ${lastReason}`);
	if (retryTimes > 0) console.error(`  ${describeRetry()}繋がりませんでした`);
	console.error('  サービスが動いているか確認してください');
	console.error('  例: node-ai-chat-lite-winsw.exe status');
	process.exit(EXIT_UNREACHABLE);
}

/** 「10 分（10 秒 × 60 回）まで」のような文字列を作る */
function describeRetry() {
	if (retryTimes === 0) return '';
	const sec = RETRY_INTERVAL_SEC * retryTimes;
	const span = sec % 60 === 0 ? `${sec / 60} 分` : `${sec} 秒`;
	return `${span}（${RETRY_INTERVAL_SEC} 秒 × ${retryTimes} 回）まで`;
}

const postJson = (path, body) =>
	call(path, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});

// --- 表示 ---

/**
 * 発言を 1 行にする。
 *
 * 先頭に #<msg_seq> を 6 桁右詰めで出す。これが無いと、受け取った発言に
 * 返信しようにも指す先を書けない。# を付けるのは、付けないと
 * 「474 2026/09/04」と数が 2 つ並び、境目を読み手が判断することになるため。
 *
 * 仕組みからの発言（join / leave / archive / notice）にも番号を出す。
 * 種別で出し分けると、読み手が「番号が無い行は何か」を考えることになる。
 */
function formatMessage(m) {
	const seq = padStartW(`#${m.msg_seq}`, 6);
	if (m.msg_kind !== 'say') return `${seq} ${m.sent_at} -- ${m.msg_body}`;

	const to = m.to_connector_id ? ` @${m.to_connector_id}` : '';
	const reply = m.reply_to_msg_seq ? ` ↳#${m.reply_to_msg_seq}` : '';
	return `${seq} ${m.sent_at} ${m.from_connector_id}${to}${reply} > ${m.msg_body}`;
}

function printMessages(messages) {
	for (const m of messages) console.log(formatMessage(m));
}

// --- コマンド ---

async function cmdJoin() {
	const role = option('role', 'ai');
	const result = await postJson('/api/join', { connector_id: CONNECTOR_ID, connector_role: role, room_id: ROOM });
	console.log(`${CONNECTOR_ID} として ${result.room_id} に参加しました（現在位置 ${result.msg_seq}）`);
	console.log(`参加者 ${result.connectors.length} 人:`);
	for (const u of result.connectors) {
		console.log(`  ${STATUS_MARK[u.status]} ${u.connector_id} (${u.status_label})`);
	}
}

async function cmdSay() {
	const body = positional();
	if (!body) {
		console.error(`本文を指定してください: say ${ID_WRAP}<自分のID>${ID_WRAP} "本文" [--to ${ID_WRAP}<相手>${ID_WRAP}] [--reply-to <msg_seq>]`);
		// 書き忘れは使い方の誤りなので 2。ここだけ 1 を返していて C# 版と食い違っていた
		process.exit(2);
	}
	const message = await postJson('/api/say', {
		from_connector_id: CONNECTOR_ID,
		room_id: ROOM,
		to_connector_id: optionalWrappedId('to'),
		reply_to_msg_seq: replyToMsgSeq(),
		msg_body: body,
	});
	console.log(`送信しました（${message.msg_seq}）`);
}

/*
 * 待受けの記録を残す。
 *
 * 待受けは背面で走るため、外から止められると何も残らない。終了コードだけが
 * 呼び出し側に届き、「いつまで生きていたか」が分からない。
 *
 * そこで 1 回の long-poll が返るたびに 1 行書く。最後の行の時刻が
 * 「最後に生きていた時刻」になるので、止められた時刻が分かる。
 *
 * 置き場は logs/client/yyyymmdd-hhmmss-<名乗る ID>.log。起動ごとに 1 本。
 * 名前の先頭を日時にすると、名前順がそのまま時系列順になる。
 *
 * 記録するのは wait だけにする。他のコマンドは短時間で終わり、出力は
 * 呼び出し側が見ている。残す意味があるのは、誰も見ていない間に落ちるものだけ。
 */

/** この待受けの記録先。開くのは wait のときだけ */
let waitLogPath = null;

/** yyyymmdd-hhmmss。JST で組み立てる */
function logStamp() {
	const jst = new Date(Date.now() + 9 * 3600 * 1000);
	const p = (n) => String(n).padStart(2, '0');
	return (
		`${jst.getUTCFullYear()}${p(jst.getUTCMonth() + 1)}${p(jst.getUTCDate())}` +
		`-${p(jst.getUTCHours())}${p(jst.getUTCMinutes())}${p(jst.getUTCSeconds())}`
	);
}

/**
 * 記録を始める。書けなければ黙って諦める（待受けは続ける）。
 *
 * テストのときは書かない。単体テストが cmdWait を呼ぶため、置き場に
 * test- で始まる記録が溜まる。実際に 7 本溜まった。
 * 置き場が本番かどうかで判断する（AICHAT_DATA を差し替えていればテスト）。
 */
function openWaitLog() {
	if (IS_TEST) return;
	try {
		const dir = join(ROOT, 'logs', 'client');
		mkdirSync(dir, { recursive: true });
		waitLogPath = join(dir, `${logStamp()}-${CONNECTOR_ID}.log`);
	} catch {
		waitLogPath = null;
	}
}

/**
 * 1 行書く。書式はサーバーのログに揃える（日時 + レベル + 本文）。
 *
 * 失敗しても黙って捨てる。記録のために待受けを止めるのは本末転倒である。
 */
function writeWaitLog(level, body) {
	if (!waitLogPath) return;
	try {
		appendFileSync(waitLogPath, `${nowJst()} ${level.padEnd(5)} ${body}\n`, 'utf8');
	} catch {
		/* 書けなくても続ける */
	}
}

async function cmdWait() {
	const { sec: limitSec, fromDefault } = resolveWaitSec();
	const unlimited = limitSec === 0;
	const label = describeWait(limitSec);

	/*
	 * 1 回の long-poll は MAX_WAIT_SEC（240 秒）で必ず返る。サーバー側で
	 * これ以上引き延ばすと、途中の切断に気づけないまま握り続けることになる。
	 * 代わりに、返ってきたら黙って張り直す。呼ぶ側から見ると 1 回の実行で
	 * 長く待てる。何回に分かれたかは呼ぶ側には関係がないので出さない。
	 */
	if (!fromDefault && !unlimited && limitSec > FOREGROUND_SEC) {
		/*
		 * 括弧は「11 分」を秒に直して見せるためのもの。--wait-sec で
		 * 指定されたときは label 自体が秒なので、同じ値が 2 度出る。
		 */
		const detail = label === `${limitSec} 秒` ? label : `${label}（${limitSec} 秒）`;
		console.error(`${detail}待つ設定です。`);
		console.error(`  前面で呼ぶと ${FOREGROUND_SEC} 秒で背面に移されます。プロセスは走り続けますが、`);
		console.error('  それまでの間、呼び出し側は待たされます。');
		console.error('  はじめから run_in_background で呼んでください。');
		console.error('');
	}

	/*
	 * 参加・離脱では起こさない。
	 *
	 * public には join と leave が数分ごとに流れるため、既定のままだと 12 時間を
	 * 指定しても数分で返っていた。ルールは「参加・離脱の記録は伝えない」なので、
	 * 読まずに捨てるもので起こされていたことになる。
	 *
	 * 絞るのはサーバー側にする。ここで捨てて待ち直すと、下の waited += wait が
	 * 「待ち切った」前提で加算しているため、実際の経過より速く上限に達する。
	 * 除いた分もサーバーがカーソルを進めるので、取りこぼしにはならない。
	 */
	const withJoins = hasFlag('with-joins');
	const excludeParam = withJoins ? '' : '&exclude=join,leave';

	/*
	 * 出すのは 2 行だけ。12 時間を 240 秒ごとに知らせると 180 行になる。
	 *
	 * 「待受け中」と進行形にしてあるのは、この 1 行だけを見た相手に
	 * 「終わった」と読ませないため。待受けを張るサブエージェントは背面の
	 * コマンドを起こした時点で自分の仕事を終えるので、親には「終了」の扱いで
	 * 通知が届く。そこで張り直すと二重になる（課題 i260905-01）。
	 *
	 * pid を添えるのは、走っているかを親が確かめられるようにするため。
	 * aichat waiters が名指しする pid と同じ値になる。
	 */
	console.log(`pid ${process.pid} で待受け中（最大 ${label}、ルーム ${ROOM}、${CONNECTOR_ID}${withJoins ? '、参加・離脱も' : ''}）`);

	openWaitLog();
	writeWaitLog(
		'INFO',
		`待受け開始（最大 ${label}、ルーム ${ROOM}、${CONNECTOR_ID}、pid ${process.pid}` +
			`${withJoins ? '、参加・離脱も' : '、参加・離脱は除く'}）`
	);

	let waited = 0;
	let last = null;
	while (unlimited || waited < limitSec) {
		const wait = unlimited ? MAX_WAIT_SEC : Math.min(MAX_WAIT_SEC, limitSec - waited);

		/*
		 * since は渡さない。どこまで読んだかはサーバーが覚えている。
		 * 一度も読んでいなければ、参加した時点から待つ扱いになる（過去ログは recent で取る）。
		 * 受け取った分は返答と同時に記録されるので、次はその続きから届く。
		 */
		last = await call(
			`/api/poll?connector_id=${encodeURIComponent(CONNECTOR_ID)}&room_id=${encodeURIComponent(ROOM)}&wait=${wait}${excludeParam}`
		);
		waited += wait;

		/*
		 * 1 回返るたびに書く。最後の行の時刻が「最後に生きていた時刻」になる。
		 * 外から止められると終わりの行は書けないため、これが手がかりになる。
		 */
		writeWaitLog(
			'INFO',
			`待機中（経過 ${waited} 秒 / 上限 ${unlimited ? '無し' : limitSec + ' 秒'}、新着 ${last.messages.length} 件、現在位置 ${last.msg_seq}）`
		);

		if (last.messages.length > 0) {
			console.log(`新着 ${last.messages.length} 件:`);
			printMessages(last.messages);
			writeWaitLog('INFO', `新着 ${last.messages.length} 件を受け取って終わります`);
			return;
		}
	}

	console.log(`新着なし（${label}待機、現在位置 ${last.msg_seq}）`);
	writeWaitLog('INFO', `新着なし。上限まで待ち切って終わります（${label}）`);
}

async function cmdRecent() {
	// -n も --n も option() が解決する。ここで個別に見る必要はない
	const limit = Number(option('n', 20)) || 20;
	const result = await call(`/api/history?room_id=${encodeURIComponent(ROOM)}&limit=${limit}`);
	if (result.messages.length === 0) {
		console.log(`${ROOM} にはまだ何もありません`);
		return;
	}
	console.log(`${ROOM} の直近 ${result.messages.length} 件:`);
	printMessages(result.messages);
}

async function cmdWho() {
	const result = await call('/api/connectors');
	if (result.connectors.length === 0) {
		console.log('まだ誰も参加していません');
		return;
	}
	const width = Math.max(...result.connectors.map((u) => u.connector_id.length));
	console.log('参加者:');
	for (const u of result.connectors) {
		const conn = u.connected ? `接続 ${u.active_connection_count}` : '';
		console.log(
			`  ${STATUS_MARK[u.status]} ${u.connector_id.padEnd(width)}  ${u.status_label.padEnd(6)}  ${u.connector_role.padEnd(5)}  最終 ${u.last_active_at}  ${conn}`
		);
	}
}

/*
 * 走っている待受けを数える。
 *
 * サーバーには繋がない。手元のプロセスだけを見る。who は「サーバーが知って
 * いる在席」を返すが、本数は分からない（1 本でも 2 本でも「接続中」になる）。
 *
 * 【なぜコマンドにしたのか】
 * これまでは各プロジェクトに検索式を書かせていた。書き方を 1 つ守れなかった
 * だけで結果が反転し、そのたびに事故になった。
 *
 *   -c で絞らない        他プロジェクトの待受けまで数え、止めてしまう（i260901-07）
 *   プロセス名で絞る      張り方によって aichat.exe / cmd.exe / node.exe に変わる
 *   ID を直に書く        確認コマンド自身に一致し、0 本が 1 本に見える
 *   前方一致             project-a を探すと project-aa にも当たる
 *
 * 4 つとも原因は同じで、「式を人に書かせている」ことである。ここで数えれば
 * 誰も式を書かない。
 *
 * 【自分自身を数えない】
 * 自分の pid を除く。加えて、待受けに当たったプロセスの親も除く。
 * サブエージェントは pwsh 越しに呼ぶので、pwsh のコマンドラインにも
 * 「aichat wait :id:」がそのまま入っており、放っておくと 1 本が 2 本になる。
 * aichat-node なら cmd.exe → node.exe と 2 段になる。親をたどって落とす。
 */
async function cmdWaiters() {
	const all = listWaiters();
	const basis = basisOf();

	if (all.length === 0) {
		console.log('待受けは走っていません。');
		console.log(`  ${basis.label} の待受けがありません。張ってください。`);
		return;
	}

	printWaiters(all, basis, CONNECTOR_ID);
}

/**
 * どこを見ている待受けを数えるか。
 *
 * --port / --url / --room で変えられる。渡さなければ本番の既定ルームになる。
 * テスト用サーバーを相手にしているときも、同じコマンドで数えられるようにする。
 *
 * ここを固定にしてしまうと、テスト環境では「全部が本番以外」に見えて
 * 使えなくなる。基準は呼ぶ側が決める。
 */
function basisOf() {
	const port = option('port');
	const url = option('url');

	/*
	 * 接続先を省略できない。既定値を持たない。
	 *
	 * 他のコマンドと同じ扱いにする。既定を本番にすると、テストのつもりで
	 * 数えたものが本番の本数として返る。「張っているから張らない」と判断して
	 * 本番の待受けが 1 本も無いまま止まる。書き込まないだけで、事故の形は同じ。
	 */
	if (port === null && url === null) {
		console.error('どこを見ている待受けを数えるかが指定されていません。');
		console.error('');
		console.error(`  本番: waiters ${ID_WRAP}<自分のID>${ID_WRAP} -p ${PORT} -r ${DEFAULT_ROOM}`);
		console.error('');
		console.error('  既定値は持ちません。テストのつもりで数えた本数を本番の本数と読み違えるのを防ぐためです。');
		process.exit(2);
	}

	let num = 0;
	if (port !== null) {
		num = Number(port);
	} else {
		const m = /:(\d+)/.exec(url);
		num = m ? Number(m[1]) : 0;
	}

	return { port: num, room: ROOM, label: `:${num} / ${ROOM}` };
}

/**
 * 待受けのプロセスを拾う。
 *
 * PowerShell に一覧を出させて JSON で受ける。Node には WMI を直に引く仕組みが
 * 無く、wmic は非推奨で将来消えるため、これが残る道になる。
 *
 * 絞り込みは JavaScript 側で行う。PowerShell に渡す式に ID を入れないので、
 * 子プロセス自身が数に混ざらない。
 */
function listWaiters() {
	const script =
		'Get-CimInstance Win32_Process | ' +
		"Where-Object { $_.CommandLine -and $_.CommandLine -like '*wait*' } | " +
		'ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; name = $_.Name; ' +
		"cmd = $_.CommandLine; at = $_.CreationDate.ToString('yyyy-MM-dd HH:mm:ss') } } | " +
		'ConvertTo-Json -Compress -Depth 3';

	const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
		encoding: 'utf8',
		maxBuffer: 32 * 1024 * 1024,
	});

	if (run.status !== 0) {
		console.error('プロセスの一覧を取れませんでした。');
		console.error(`  ${(run.stderr ?? '').trim() || 'powershell.exe が動きませんでした'}`);
		process.exit(1);
	}

	const text = (run.stdout ?? '').trim();
	if (!text) return [];

	// 1 件のときオブジェクト、複数のとき配列で返る
	const parsed = JSON.parse(text);
	const rows = Array.isArray(parsed) ? parsed : [parsed];

	return pickWaiters(rows, [process.pid, run.pid]);
}

/**
 * 一覧から待受けだけを選ぶ。
 *
 * 引数で渡した pid（自分と、一覧を取るために起こした子）は最初に外す。
 * テストから直に呼べるよう、プロセスを触る部分と分けてある。
 */
function pickWaiters(rows, excludePids) {
	const skip = new Set(excludePids);
	const re = new RegExp(WAITER_PATTERN);

	const hits = [];
	for (const r of rows) {
		if (skip.has(r.pid)) continue;
		const m = re.exec(r.cmd ?? '');
		if (!m) continue;
		hits.push({
			pid: r.pid,
			ppid: r.ppid,
			name: r.name,
			at: r.at,
			id: m[1] ?? m[2],
			...targetOf(r.cmd ?? ''),
		});
	}

	/*
	 * 親を落とす。pwsh → aichat.exe や pwsh → cmd.exe → node.exe と連なるとき、
	 * 途中の段はすべて同じコマンドラインを抱えているため全部が当たってしまう。
	 * 「当たったものの直親」を落とすと、連鎖でも末端 1 つだけが残る。
	 */
	const parents = new Set(hits.map((h) => h.ppid));
	const leaves = hits.filter((h) => !parents.has(h.pid));

	// 親の名前から張り方を決める。cmd.exe 越しの node は aichat-node である
	const nameOf = new Map(hits.map((h) => [h.pid, h.name]));
	for (const h of leaves) h.via = viaOf(h.name, nameOf.get(h.ppid));

	return leaves.sort((a, b) => (a.at === b.at ? a.pid - b.pid : a.at < b.at ? -1 : 1));
}

/** コマンドラインから「--name 値」を読む。短い形も同じ値として受ける */
function readArg(cmd, long, short) {
	const m = new RegExp(`(?:^|\\s)(?:--${long}|-${short})\\s+([^\\s"]+)`).exec(cmd);
	return m ? m[1] : null;
}

/**
 * その待受けが「どこを待っているか」を読む。
 *
 * 【なぜ要るのか】
 * 本数だけ数えても、待っている場所が違えば意味がない。とくにルームは
 * 間違えても静かに動く。繋がっているので who は「接続中」と出し、waiters も
 * 1 本と数えるが、public の発言は 1 つも届かない。どこも異常に見えない。
 *
 * ポートは間違えれば繋がらないか別のサーバーに繋がるので、まだ気づける。
 * ルームはそれが無い。だから両方を出す。
 *
 * 値はすべて引数で渡す決まりなので、コマンドラインを読めば分かる。
 * 環境変数で渡せるようにしていないのは、まさにこのためである。
 */
function targetOf(cmd) {
	const port = readArg(cmd, 'port', 'p');
	const url = readArg(cmd, 'url', 'u');
	const room = readArg(cmd, 'room', 'r') ?? DEFAULT_ROOM;

	let target = '(未指定)';
	let portNum = 0;

	if (port !== null) {
		target = `:${port}`;
		portNum = Number(port);
	} else if (url !== null) {
		// スキームは落として host:port だけ出す
		target = url.replace(/^[a-z]+:\/\//i, '').replace(/\/+$/, '');
		const m = /:(\d+)/.exec(target);
		portNum = m ? Number(m[1]) : 0;
	}

	return { target, room, port: portNum };
}

/** 張り方の名前。出力に出るのは aichat / aichat-node / node の 3 つ */
function viaOf(name, parentName) {
	const lower = (name ?? '').toLowerCase();
	if (lower === 'aichat.exe') return 'aichat';
	if (lower === 'node.exe') return (parentName ?? '').toLowerCase() === 'cmd.exe' ? 'aichat-node' : 'node';
	return lower.replace(/\.exe$/, '');
}

/** 経過を h:mm で返す。日をまたいでも時のまま増やす（2 日なら 48:00 になる） */
function elapsedOf(at, now = new Date()) {
	const started = new Date(at.replace(' ', 'T'));
	const min = Math.max(0, Math.floor((now - started) / 60000));
	return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;
}

/*
 * 一覧を出す。C# 版と 1 文字ずつ同じにする（テストで突き合わせている）。
 *
 * 幅は文字数ではなく表示幅で揃える。「張り方」は 3 文字だが 6 桁を占めるため、
 * padEnd で数えると列がずれる。
 */
function printWaiters(all, basis, me) {
	// 基準に合う分だけを並べる。合わない分は件数だけ添える
	const here = all.filter((h) => h.port === basis.port && h.room === basis.room);
	const elsewhere = all.filter((h) => !(h.port === basis.port && h.room === basis.room));

	console.log(`  ${basis.label} を見ている待受け`);
	console.log('');

	if (here.length === 0) {
		console.log('  ありません。');
	} else {
		const idWidth = Math.max(width('ID'), ...here.map((h) => width(h.id)));
		const viaWidth = Math.max(width('張り方'), ...here.map((h) => width(h.via)));

		console.log(
			`  ${padEndW('ID', idWidth)}  ${padEndW('張り方', viaWidth)}  ${padEndW('いつから', 8)}  ` +
				`${padStartW('経過', 5)}  ${padStartW('pid', 6)}`
		);
		for (const h of here) {
			// 自分の分に印を付ける。止めてよいのはこれだけである
			const mark = h.id === me ? '*' : ' ';
			console.log(
				`${mark} ${padEndW(h.id, idWidth)}  ${padEndW(h.via, viaWidth)}  ${h.at.slice(11)}  ` +
					`${padStartW(elapsedOf(h.at), 5)}  ${padStartW(String(h.pid), 6)}`
			);
		}
	}

	const mine = here.filter((h) => h.id === me);

	console.log('');
	console.log(`  自分（${me}）: ${mine.length} 本 / この場所に ${here.length} 本`);

	/*
	 * 別の場所を見ている自分の分は、pid まで出す。
	 *
	 * ルームを間違えた待受けは静かに動く。繋がっているので who は「接続中」と
	 * 出すが、この場所の発言は 1 つも届かない。件数だけでは止めようがないので
	 * pid を添える。他プロジェクトの分は件数だけにする（止めてはいけないため）。
	 */
	const strayMine = elsewhere.filter((h) => h.id === me);
	if (strayMine.length > 0) {
		const shown = strayMine.map((h) => `pid ${h.pid}（${h.target} / ${h.room}）`).join('、');
		console.log(`  自分の分が別の場所に ${strayMine.length} 本: ${shown}`);
	}

	const others = elsewhere.length - strayMine.length;
	if (others > 0) console.log(`  他に ${others} 本（別の接続先やルーム）`);

	/*
	 * 次にやることを書く。事実だけ出すと、読み手が判断のためにルールを
	 * 思い出すことになる。その場に要る 1 行をここに出す。
	 *
	 * ただし指示するのは自分の分についてだけにし、対象を名指しする。
	 * 「1 本だけ残してください」のように読み手に選ばせると、他プロジェクトの
	 * 待受けを止める事故が起きる（i260901-07）。
	 */
	if (mine.length === 0) {
		console.log(`  ${basis.label} の待受けがありません。張ってください。`);
	} else if (mine.length > 1) {
		// 経過が長い方を残す。読み位置はサーバーが覚えているので取りこぼさない
		const keep = mine[0];
		const stop = mine.slice(1).map((h) => h.pid).join(', ');
		console.log(`  二重に張っています。pid ${stop} を止めてください（pid ${keep.pid} を残す）。`);
	}
}

async function cmdDump() {
	const out = option('out', join(ROOT, 'tmp', 'messages.jsonl'));
	/*
	 * /api/dump はルームで絞らず、片付けたものも含めて全件を返す。
	 * 切り分けに使うものなので、見えているものだけでは足りない。
	 */
	const result = await call('/api/dump');
	mkdirSync(join(ROOT, 'tmp'), { recursive: true });
	writeFileSync(out, result.messages.map((m) => JSON.stringify(m)).join('\n') + '\n', 'utf8');
	const archived = result.messages.filter((m) => m.archived_seq !== null).length;
	console.log(`${result.messages.length} 件を書き出しました（片付けたもの ${archived} 件を含む）: ${out}`);
}

async function cmdLeave() {
	await postJson('/api/leave', { connector_id: CONNECTOR_ID, room_id: ROOM });
	console.log(`${CONNECTOR_ID} として離脱しました`);
}

/**
 * 落とす。再起動されるかどうかは終了コードで決まる。
 *   restart … 終了コード 1。異常終了として扱われ、10 秒後に起動し直す
 *   stop    … 終了コード 0。正常終了として扱われ、止まったまま
 *
 * サービスの再起動と違い管理者権限が要らないため、ソースを直したあとの反映に使える。
 */
async function cmdExit(exitCode) {
	const result = await postJson('/api/admin/exit', { connector_id: CONNECTOR_ID, exit_code: exitCode });
	console.log(`終了コード ${result.exit_code} で終了します`);
	console.log(`  ${result.note}`);
	if (result.will_restart) {
		console.log('  10 秒ほど待ってから接続してください');
	} else if (result.managed_by) {
		console.log('  もう一度動かすには: node-ai-chat-lite-winsw.exe start');
	}
}

/**
 * 説明を桁で揃える。
 *
 * 日本語は半角 2 つ分の幅で表示されるため、文字数ではなく表示幅で数える。
 * 文字数で揃えると、日本語を含む行だけ右にずれる。
 */
const HELP_COLUMN = 40;

function width(s) {
	let w = 0;
	for (const ch of s) w += /[ -~]/.test(ch) ? 1 : 2;
	return w;
}

/** 表示幅で右に詰める。全角を 2 桁として数える */
function padEndW(text, w) {
	return text + ' '.repeat(Math.max(0, w - width(text)));
}

/** 表示幅で左に詰める */
function padStartW(text, w) {
	return ' '.repeat(Math.max(0, w - width(text))) + text;
}

function helpLine(indent, left, desc) {
	const head = ' '.repeat(indent) + left;
	const pad = Math.max(1, HELP_COLUMN - width(head));
	return head + ' '.repeat(pad) + desc;
}

/** オプション 1 つを「--long <arg>  -s」の形にする */
function optionLabel(o) {
	const long = `--${o.long}${o.arg ? ' ' + o.arg : ''}`;
	return o.short ? `${long}  -${o.short}` : long;
}

/** コマンドと、そのコマンドだけのオプションを並べる */
function commandBlock(list) {
	const lines = [];
	for (const c of list) {
		lines.push(helpLine(2, c.arg ? `${c.name} ${c.arg}` : c.name, c.desc));
		for (const o of OPTIONS.filter((x) => x.cmd === c.name)) {
			lines.push(helpLine(6, optionLabel(o), o.desc));
		}
	}
	return lines.join('\n');
}

function usage() {
	const globals = OPTIONS.filter((o) => o.cmd === null)
		.map((o) => helpLine(2, optionLabel(o), o.desc))
		.join('\n');

	console.log(`ai-chat-lite クライアント

  接続先: ${BASE ?? `(未指定)  ← --port ${PORT} か --url <URL> を渡してください`}
  名乗る ID: ${CONNECTOR_ID ?? `(未指定)  ← コマンドの直後に ${ID_WRAP}<自分のID>${ID_WRAP} を置いてください`}
  ルーム: ${ROOM}         （--room で変更できる）

コマンド:
${commandBlock(COMMANDS)}

サーバーの操作（管理者権限は要らない）:
${commandBlock(ADMIN_COMMANDS)}

どのコマンドにも付けられるもの:
${globals}
`);
}

// --- 片付ける（archive） ---

/** 何件片付くかを先に出す。件数が思っていたより多ければ、そこで気づける */
function printPreview(kind, id, counts) {
	const label = { message: '発言', connector: '参加者', room: 'ルーム' }[kind];
	console.log(`${label} ${id} を片付けると、次が見えなくなります。`);
	if (counts.messages > 0) {
		const span = counts.first && counts.last ? `（${counts.first.slice(5, 16)} 〜 ${counts.last.slice(5, 16)}）` : '';
		console.log(`  発言       ${String(counts.messages).padStart(4)} 件${span}`);
	}
	if (counts.cursors > 0) console.log(`  読んだ位置 ${String(counts.cursors).padStart(4)} 件`);
	if (counts.connectors > 0) console.log(`  参加者     ${String(counts.connectors).padStart(4)} 件`);
	console.log('archives に記録され、restore で戻せます。');
}

/**
 * 標準入力から 1 行読む。
 *
 * y では通さず、対象の名前を打たせる。勢いで確定させないため。
 * 前面で人が打つとき用。パイプで渡されていれば、その 1 行を使う。
 */
function readLine(prompt) {
	process.stdout.write(prompt);
	return new Promise((resolve) => {
		let buf = '';
		process.stdin.setEncoding('utf8');
		const onData = (chunk) => {
			buf += chunk;
			const nl = buf.indexOf('\n');
			if (nl < 0) return;
			process.stdin.off('data', onData);
			process.stdin.pause();
			resolve(buf.slice(0, nl).trim());
		};
		process.stdin.on('data', onData);
		process.stdin.resume();
	});
}

async function cmdArchive() {
	const [kind, rawId] = TAIL;
	if (!kind || !rawId) {
		console.error(`対象を指定してください: archive ${ID_WRAP}<自分のID>${ID_WRAP} message|connector|room <対象>`);
		process.exit(2);
	}
	if (!['message', 'connector', 'room'].includes(kind)) {
		console.error(`kind は message / connector / room です: ${kind}`);
		process.exit(2);
	}

	/*
	 * 参加者を片付けるときだけ、対象も参加者の ID なのでコロンで囲む。
	 * 発言は番号、ルームはルーム ID なので囲まない。囲みの対象は参加者の ID だけ。
	 */
	const id = kind === 'connector' ? unwrapId(rawId, 'archive connector の対象') : rawId;

	/*
	 * 既定のルームはサーバー側でも弾くが、ここでも先に弾く。
	 * 下見を出して名前まで打たせてから断るのは、手間をかけさせるだけになる。
	 */
	if (kind === 'room' && id === DEFAULT_ROOM) {
		console.error(`${DEFAULT_ROOM} は片付けられません（参加時の行き先です）`);
		process.exit(2);
	}

	const withMessages = hasFlag('with-messages');
	const query = `/api/admin/archive-preview?kind=${kind}&id=${encodeURIComponent(id)}${withMessages ? '&with_messages=1' : ''}`;
	const counts = await call(query);

	if (counts.messages + counts.cursors + counts.connectors === 0) {
		console.error(`片付けるものがありません: ${kind} ${id}`);
		process.exit(1);
	}

	printPreview(kind, id, counts);
	const answer = await readLine(`本当に片付ける場合は「${id}」と入力してください: `);
	if (answer !== id) {
		console.log('中止しました。');
		process.exit(1);
	}

	const result = await postJson('/api/admin/archive', {
		kind,
		id,
		with_messages: withMessages,
		description: option('description') ?? undefined,
		connector_id: requireConnectorId(),
		confirm: id,
	});

	console.log(`片付けました（archived_seq ${result.archived_seq}）`);
	console.log(`  ${result.description}`);
	console.log(`戻すには: restore ${ID_WRAP}${CONNECTOR_ID}${ID_WRAP} ${result.archived_seq}`);
}

async function cmdArchives() {
	const { archives } = await call('/api/admin/archives');
	if (archives.length === 0) {
		console.log('片付けたものはありません。');
		return;
	}
	/*
	 * 対象（kind と id）を説明とは別の列で出す。
	 * 説明は --description で書き換えられるため、そこだけ見ても対象が分からない。
	 */
	const label = { message: '発言', connector: '参加者', room: 'ルーム' };
	const targets = archives.map((a) => `${label[a.archive_kind] ?? a.archive_kind} ${a.archive_id}`);
	const width = Math.max(4, ...targets.map((t) => [...t].length));

	console.log(`  seq  片付けた日時             ${'対象'.padEnd(width)}  件数  説明`);
	for (const [i, a] of archives.entries()) {
		const count = Number(a.msg_count) + Number(a.cursor_count) + Number(a.connector_count);
		console.log(
			`${String(a.archived_seq).padStart(5)}  ${a.archived_at}  ${targets[i].padEnd(width)}  ` +
				`${String(count).padStart(4)}  ${a.description}`
		);
	}
}

async function cmdRestore() {
	const seq = positional();
	if (!seq || !/^\d+$/.test(seq)) {
		console.error(`戻す番号を指定してください: restore ${ID_WRAP}<自分のID>${ID_WRAP} <archived_seq>`);
		process.exit(2);
	}

	const result = await postJson('/api/admin/restore', {
		archived_seq: Number(seq),
		connector_id: requireConnectorId(),
	});

	console.log(`archived_seq ${result.archived_seq} を戻しました（${result.restored} 件）`);
	console.log(`  ${result.description}`);
}

/*
 * どちらの環境に繋いだかを、何かする前に出す。
 *
 * テスト用の ID を名乗れば隔離される、と思い込んで本番へ繋いだ事故があった。
 * 隔離しているのは AICHAT_DATA とポートで、ID は何も分けていない。ルーム名も
 * 本番とテストで同じ public なので手がかりにならない。サーバーに聞けば必ず
 * 分かるので、繋ぐコマンドでは毎回聞いて先頭に出す。
 *
 * 出すのは stderr。recent や dump の出力（stdout）に混ぜない。
 */
function isOfflineCommand(name) {
	const def = [...COMMANDS, ...ADMIN_COMMANDS].find((c) => c.name === name);
	return Boolean(def?.offline);
}

function describePlace() {
	const found = /^http:\/\/localhost:(\d+)$/.exec(BASE ?? '');
	return found ? `:${found[1]}` : BASE;
}

async function announceEnv() {
	const base = requireBase();

	/*
	 * 取れなければ黙って諦める。印は補助なので、ここで粘る意味がない。
	 * 粘ると、使い方の誤りが「繋がらない待ち」に埋もれる（--wait-hour と
	 * --wait-min を同時に渡したときの終了コード 2 が、600 秒かけて 3 に
	 * なっていた）。繋がらないことの案内は、本来の呼び出しが出す。
	 */
	let info;
	try {
		const res = await fetch(`${base}/api/version`, { signal: AbortSignal.timeout(3000) });
		if (!res.ok) return;
		info = await res.json();
	} catch {
		return;
	}

	console.error(`${info.env === 'test' ? 'テスト' : '本番'}（${describePlace()}）`);
}
const commands = {
	join: cmdJoin,
	wait: cmdWait,
	say: cmdSay,
	recent: cmdRecent,
	who: cmdWho,
	waiters: cmdWaiters,
	dump: cmdDump,
	leave: cmdLeave,
	archive: cmdArchive,
	archives: cmdArchives,
	restore: cmdRestore,
	restart: () => cmdExit(1),
	stop: () => cmdExit(0),
};

/*
 * 使い方を出して終わるのは 3 通り。
 *   コマンドを付けない / -h・--help を付ける / 知らないコマンドを渡す
 *
 * 知らないコマンドだけは終了コード 1 にする。書き間違いに気づけるようにするため。
 */
const run = commands[command];
const wantsHelp = hasFlag('help');
if (wantsHelp || !run) {
	usage();
	// 旗で呼んだときと、何も付けないときは 0。知らないコマンドだけ 1
	process.exit(!wantsHelp && command ? 1 : 0);
}

// 読むだけのコマンド以外は、名乗る ID が要る
if (!READ_ONLY_COMMAND) requireConnectorId();

// サーバーに繋ぐコマンドなら、どちらの環境かを先に出す
if (!isOfflineCommand(command)) await announceEnv();

await run();
