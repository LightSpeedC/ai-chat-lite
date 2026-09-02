import { basename, join } from 'node:path';
import { writeFileSync, mkdirSync, appendFileSync } from 'node:fs';

import { ROOT, PORT, DEFAULT_ROOM, MAX_WAIT_SEC, IS_TEST } from '../server/config.mjs';
import { nowJst } from '../server/time.mjs';
import {
	WAIT_UNITS,
	DEFAULT_WAIT_SEC,
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

for (const [name, hint] of REMOVED) {
	if (WORDS.includes(`--${name}`)) {
		console.error(`--${name} は廃止されました。`);
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
 * 名乗る ID。
 *
 * --connector-id での明示を必須にしている。カレントのフォルダ名を自動で使うと、
 * 想定と違う場所から実行したときに意図しない ID で参加してしまい、
 * その名前が connectors とログに残る。取り違えは後から消せないため、
 * 手軽さより確実さを採る。
 *
 * 環境変数ではなく引数で受ける。環境変数はプロセス一覧に出ないため、
 * 動いている待受けがどのプロジェクトのものか分からない。引数なら
 * コマンドラインに出るし、シェルごとの書き方の違いもなくなる。
 */
const CONNECTOR_ID = option('connector-id');

function requireConnectorId() {
	if (CONNECTOR_ID) return CONNECTOR_ID;

	console.error('名乗る ID が指定されていません。');
	console.error('');
	console.error('  --connector-id で指定してください:');
	console.error(`    --connector-id ${basename(process.cwd())}`);
	console.error('');
	console.error('  自分の project フォルダ名にしておくと、誰の発言か分かりやすくなります。');
	console.error('  短い形は -c です。');
	process.exit(1);
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
 * 「上限なし」と書いたつもりが既定の 8 時間に化ける。
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

/** オプションでない最初の引数（本文など） */
function positional() {
	return positionals()[0] ?? null;
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

function formatMessage(m) {
	const to = m.to_connector_id ? ` @${m.to_connector_id}` : '';
	if (m.msg_kind !== 'say') return `${m.sent_at} -- ${m.msg_body}`;
	return `${m.sent_at} ${m.from_connector_id}${to} > ${m.msg_body}`;
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
		console.error('本文を指定してください: say "本文" [--to <id>]');
		process.exit(1);
	}
	const message = await postJson('/api/say', {
		from_connector_id: CONNECTOR_ID,
		room_id: ROOM,
		to_connector_id: option('to'),
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
		console.error(`${label}（${limitSec} 秒）待つ設定です。`);
		console.error(`  前面で呼ぶと ${FOREGROUND_SEC} 秒で背面に移されます。プロセスは走り続けますが、`);
		console.error('  それまでの間、呼び出し側は待たされます。');
		console.error('  はじめから run_in_background で呼んでください。');
		console.error('');
	}

	// 出すのは開始と終了の 2 行だけ。8 時間を 240 秒ごとに知らせると 120 行になる
	console.log(`待受け開始（最大 ${label}、ルーム ${ROOM}、${CONNECTOR_ID}）`);

	openWaitLog();
	writeWaitLog('INFO', `待受け開始（最大 ${label}、ルーム ${ROOM}、${CONNECTOR_ID}、pid ${process.pid}）`);

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
			`/api/poll?connector_id=${encodeURIComponent(CONNECTOR_ID)}&room_id=${encodeURIComponent(ROOM)}&wait=${wait}`
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
  名乗る ID: ${CONNECTOR_ID ?? '(未指定)  ← --connector-id <id> を渡してください'}
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
	const [kind, id] = positionals();
	if (!kind || !id) {
		console.error('対象を指定してください: archive message|connector|room <対象>');
		process.exit(2);
	}
	if (!['message', 'connector', 'room'].includes(kind)) {
		console.error(`kind は message / connector / room です: ${kind}`);
		process.exit(2);
	}

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
	console.log(`戻すには: restore ${result.archived_seq}`);
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
		console.error('戻す番号を指定してください: restore <archived_seq>');
		process.exit(2);
	}

	const result = await postJson('/api/admin/restore', {
		archived_seq: Number(seq),
		connector_id: requireConnectorId(),
	});

	console.log(`archived_seq ${result.archived_seq} を戻しました（${result.restored} 件）`);
	console.log(`  ${result.description}`);
}

const commands = {
	join: cmdJoin,
	wait: cmdWait,
	say: cmdSay,
	recent: cmdRecent,
	who: cmdWho,
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
if (!READ_ONLY.has(command)) requireConnectorId();

await run();
