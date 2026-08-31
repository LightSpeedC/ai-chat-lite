import { basename, join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';

import { ROOT, PORT, DEFAULT_ROOM, MAX_WAIT_SEC } from '../server/config.mjs';

/**
 * ai-chat-lite の CLI クライアント。
 *
 * AI セッションと人間の両方が同じものを使う。DB は触らず、すべて HTTP 越しに行う。
 * wait は「1 回待って、結果を出して終わる」形にしてあり、自分ではループしない。
 * そのままサブエージェントに渡せるようにするため。
 */

const BASE = process.env.AICHAT_URL ?? `http://localhost:${PORT}`;

/**
 * 名乗る ID。
 *
 * 環境変数での明示を必須にしている。カレントのフォルダ名を自動で使うと、
 * 想定と違う場所から実行したときに意図しない ID で参加してしまい、
 * その名前が users とログに残る。取り違えは後から消せないため、
 * 手軽さより確実さを採る。
 */
const USER_ID = process.env.AICHAT_ID ?? null;

/** ID を使わないコマンド。読むだけなので名乗る必要がない */
const READ_ONLY = new Set(['recent', 'who', 'dump']);

function requireUserId() {
	if (USER_ID) return USER_ID;

	console.error('AICHAT_ID が設定されていません。');
	console.error('');
	console.error('  名乗る ID を環境変数で指定してください:');
	console.error(`    $env:AICHAT_ID = '${basename(process.cwd())}'`);
	console.error('');
	console.error('  自分の project フォルダ名にしておくと、誰の発言か分かりやすくなります。');
	console.error('  環境変数はセッションごとに消えるため、開くたびに設定してください。');
	process.exit(1);
}

const STATUS_MARK = { online: '●', grace: '◐', offline: '○' };

/**
 * wait を既定で何回繰り返すか。
 *
 * 240 秒 × 2 回 = 480 秒。前面で呼ばれても背面に移される前に終わる長さにしてある。
 * 長く待つときは --retry-count で増やし、run_in_background で呼ぶ。
 */
const DEFAULT_WAIT_ROUNDS = 2;

/**
 * 前面のツール実行が背面に移されるまでの秒数。
 *
 * 打ち切られるのではない。プロセスはそのまま走り続ける。
 * ただしそれまで呼び出し側が待たされるため、これを超える設定には警告を出す。
 */
const FOREGROUND_SEC = 600;

// --- 引数 ---

const [, , command, ...rest] = process.argv;

/** --name value 形式のオプションを取り出す */
function option(name, fallback = null) {
	const i = rest.indexOf(`--${name}`);
	if (i >= 0 && rest[i + 1] !== undefined) return rest[i + 1];
	return fallback;
}

/**
 * 待ち直す回数として受け取った値を解釈する。
 *
 * `Number(x) || 既定値` と書いてはいけない。0 は falsy なので、
 * 「0 回」と書いたつもりが既定値に化ける。ここでは 0 や負の数を
 * 「1 回」に丸め、数として読めないときだけ既定値に戻す。
 */
function roundsOf(raw) {
	if (raw === null || raw === undefined || raw === '') return DEFAULT_WAIT_ROUNDS;
	const n = Number(raw);
	if (!Number.isFinite(n)) return DEFAULT_WAIT_ROUNDS;
	return Math.max(1, Math.trunc(n));
}

/** オプションでない最初の引数（本文など） */
function positional() {
	const args = [];
	for (let i = 0; i < rest.length; i++) {
		if (rest[i].startsWith('--') || rest[i].startsWith('-')) {
			i++; // 値も飛ばす
			continue;
		}
		args.push(rest[i]);
	}
	return args[0] ?? null;
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

async function call(path, init) {
	const headers = { ...(init?.headers ?? {}) };
	if (ACCESS_TOKEN) headers['X-AiChat-Access-Token'] = ACCESS_TOKEN;

	let res;
	try {
		res = await fetch(BASE + path, { ...init, headers });
	} catch (err) {
		console.error(`サーバーに繋がりません: ${BASE}`);
		console.error('  サービスが動いているか確認してください');
		console.error('  例: node-ai-chat-lite-winsw.exe status');
		console.error(`  詳細: ${err?.cause?.code ?? err?.message ?? err}`);
		process.exit(1);
	}
	const json = await res.json().catch(() => ({}));
	if (!res.ok) {
		console.error(`エラー (${res.status}): ${json.error ?? '不明'}`);
		if (json.detail) console.error(`  ${json.detail}`);
		process.exit(1);
	}
	return json;
}

const postJson = (path, body) =>
	call(path, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});

// --- 表示 ---

function formatMessage(m) {
	const to = m.to_user_id ? ` @${m.to_user_id}` : '';
	if (m.msg_kind !== 'say') return `${m.sent_at} -- ${m.msg_body}`;
	return `${m.sent_at} ${m.from_user_id}${to} > ${m.msg_body}`;
}

function printMessages(messages) {
	for (const m of messages) console.log(formatMessage(m));
}

// --- コマンド ---

async function cmdJoin() {
	const role = option('role', 'ai');
	const result = await postJson('/api/join', { user_id: USER_ID, user_role: role, room_id: ROOM });
	console.log(`${USER_ID} として ${result.room_id} に参加しました（現在位置 ${result.msg_seq}）`);
	console.log(`参加者 ${result.users.length} 人:`);
	for (const u of result.users) {
		console.log(`  ${STATUS_MARK[u.status]} ${u.user_id} (${u.status_label})`);
	}
}

async function cmdSay() {
	const body = positional();
	if (!body) {
		console.error('本文を指定してください: say "本文" [--to <id>]');
		process.exit(1);
	}
	const message = await postJson('/api/say', {
		from_user_id: USER_ID,
		room_id: ROOM,
		to_user_id: option('to'),
		msg_body: body,
	});
	console.log(`送信しました（${message.msg_seq}）`);
}

async function cmdWait() {
	const timeout = Math.min(Number(option('timeout', MAX_WAIT_SEC)) || MAX_WAIT_SEC, MAX_WAIT_SEC);
	const rounds = roundsOf(option('retry-count'));
	const totalSec = timeout * rounds;

	/*
	 * 待ち直す理由。
	 *
	 * 1 回の long-poll は MAX_WAIT_SEC（240 秒）で必ず返る。サーバー側で
	 * これ以上引き延ばすと、途中の切断に気づけないまま握り続けることになる。
	 * 代わりに、返ってきたら黙って待ち直す。呼ぶ側から見ると 1 回の実行で
	 * 長く待てる。
	 */
	if (totalSec > FOREGROUND_SEC) {
		console.error(`合計 ${totalSec} 秒（${Math.round(totalSec / 60)} 分）待つ設定です。`);
		console.error(`  前面で呼ぶと ${FOREGROUND_SEC} 秒で背面に移されます。プロセスは走り続けますが、`);
		console.error('  それまでの間、呼び出し側は待たされます。');
		console.error('  はじめから run_in_background で呼んでください。');
		console.error('');
	}

	let last = null;
	for (let round = 1; round <= rounds; round++) {
		/*
		 * since は渡さない。どこまで読んだかはサーバーが覚えている。
		 * 一度も読んでいなければ、参加した時点から待つ扱いになる（過去ログは recent で取る）。
		 * 受け取った分は返答と同時に記録されるので、次はその続きから届く。
		 */
		last = await call(
			`/api/poll?user_id=${encodeURIComponent(USER_ID)}&room_id=${encodeURIComponent(ROOM)}&wait=${timeout}`
		);

		if (last.messages.length > 0) {
			console.log(`新着 ${last.messages.length} 件:`);
			printMessages(last.messages);
			return;
		}

		// 最後の回は下でまとめて出す。途中経過だけをここで知らせる
		if (round < rounds) {
			console.log(`新着なし（${round}/${rounds} 回目、${timeout} 秒）。待ち直します`);
		}
	}

	console.log(`新着なし（${rounds} 回・合計 ${totalSec} 秒待機、現在位置 ${last.msg_seq}）`);
}

async function cmdRecent() {
	const limit = Number(option('n', rest.includes('-n') ? rest[rest.indexOf('-n') + 1] : 20)) || 20;
	const result = await call(`/api/history?room_id=${encodeURIComponent(ROOM)}&limit=${limit}`);
	if (result.messages.length === 0) {
		console.log(`${ROOM} にはまだ何もありません`);
		return;
	}
	console.log(`${ROOM} の直近 ${result.messages.length} 件:`);
	printMessages(result.messages);
}

async function cmdWho() {
	const result = await call('/api/users');
	if (result.users.length === 0) {
		console.log('まだ誰も参加していません');
		return;
	}
	const width = Math.max(...result.users.map((u) => u.user_id.length));
	console.log('参加者:');
	for (const u of result.users) {
		const conn = u.connected ? `接続 ${u.active_connection_count}` : '';
		console.log(
			`  ${STATUS_MARK[u.status]} ${u.user_id.padEnd(width)}  ${u.status_label.padEnd(6)}  ${u.user_role.padEnd(5)}  最終 ${u.last_active_at}  ${conn}`
		);
	}
}

async function cmdDump() {
	const out = option('out', join(ROOT, 'tmp', 'messages.jsonl'));
	const result = await call(`/api/history?room_id=${encodeURIComponent(ROOM)}&limit=500`);
	mkdirSync(join(ROOT, 'tmp'), { recursive: true });
	writeFileSync(out, result.messages.map((m) => JSON.stringify(m)).join('\n') + '\n', 'utf8');
	console.log(`${result.messages.length} 件を書き出しました: ${out}`);
}

async function cmdLeave() {
	await postJson('/api/leave', { user_id: USER_ID, room_id: ROOM });
	console.log(`${USER_ID} として離脱しました`);
}

/**
 * 落とす。再起動されるかどうかは終了コードで決まる。
 *   restart … 終了コード 1。異常終了として扱われ、10 秒後に起動し直す
 *   stop    … 終了コード 0。正常終了として扱われ、止まったまま
 *
 * サービスの再起動と違い管理者権限が要らないため、ソースを直したあとの反映に使える。
 */
async function cmdExit(exitCode) {
	const result = await postJson('/api/admin/exit', { user_id: USER_ID, exit_code: exitCode });
	console.log(`終了コード ${result.exit_code} で終了します`);
	console.log(`  ${result.note}`);
	if (result.will_restart) {
		console.log('  10 秒ほど待ってから接続してください');
	} else if (result.managed_by) {
		console.log('  もう一度動かすには: node-ai-chat-lite-winsw.exe start');
	}
}

function usage() {
	console.log(`ai-chat-lite クライアント

  接続先: ${BASE}
  名乗る ID: ${USER_ID ?? '(未設定)  ← $env:AICHAT_ID で指定してください'}
  ルーム: ${ROOM}         （--room で変更できる）

コマンド:
  join   [--role ai|human]   参加登録する
  wait   [--timeout ${MAX_WAIT_SEC}]      新着を待つ。届いたら出して終わる
         [--retry-count ${DEFAULT_WAIT_ROUNDS}]    新着が無いとき待ち直す回数。--timeout × 回数だけ待つ
  say    "本文" [--to <id>]  投稿する
  recent [-n 20]             直近の履歴を出す
  who                        参加者と状態を出す
  dump   [--out <path>]      JSONL に書き出す
  leave                      離脱を知らせる

サーバーの操作（管理者権限は要らない）:
  restart                    落として起動し直させる（ソース修正の反映に使う）
  stop                       止める。起動し直すには winsw の start が要る

どのコマンドにも付けられるもの:
  --room <id>                ルームを変える
  --access-token <値>        テスト用のサーバーへ繋ぐときだけ要る。本番では要らない
`);
}

const commands = {
	join: cmdJoin,
	wait: cmdWait,
	say: cmdSay,
	recent: cmdRecent,
	who: cmdWho,
	dump: cmdDump,
	leave: cmdLeave,
	restart: () => cmdExit(1),
	stop: () => cmdExit(0),
};

const run = commands[command];
if (!run) {
	usage();
	process.exit(command ? 1 : 0);
}

// 読むだけのコマンド以外は、名乗る ID が要る
if (!READ_ONLY.has(command)) requireUserId();

await run();
