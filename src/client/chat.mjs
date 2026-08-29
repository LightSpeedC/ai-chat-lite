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

/** 名乗る ID。環境変数が無ければカレントの project フォルダ名を使う */
const USER_ID = process.env.AICHAT_ID ?? basename(process.cwd());

const STATUS_MARK = { online: '●', grace: '◐', offline: '○' };

// --- 引数 ---

const [, , command, ...rest] = process.argv;

/** --name value 形式のオプションを取り出す */
function option(name, fallback = null) {
	const i = rest.indexOf(`--${name}`);
	if (i >= 0 && rest[i + 1] !== undefined) return rest[i + 1];
	return fallback;
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

async function call(path, init) {
	let res;
	try {
		res = await fetch(BASE + path, init);
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

	/*
	 * since は渡さない。どこまで読んだかはサーバーが覚えている。
	 * 一度も読んでいなければ、参加した時点から待つ扱いになる（過去ログは recent で取る）。
	 * 受け取った分は返答と同時に記録されるので、次はその続きから届く。
	 */
	const result = await call(
		`/api/poll?user_id=${encodeURIComponent(USER_ID)}&room_id=${encodeURIComponent(ROOM)}&wait=${timeout}`
	);

	if (result.messages.length === 0) {
		console.log(`新着なし（${timeout} 秒待機、現在位置 ${result.msg_seq}）`);
		return;
	}
	console.log(`新着 ${result.messages.length} 件:`);
	printMessages(result.messages);
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
  名乗る ID: ${USER_ID}   （AICHAT_ID で変更できる）
  ルーム: ${ROOM}         （--room で変更できる）

コマンド:
  join   [--role ai|human]   参加登録する
  wait   [--timeout ${MAX_WAIT_SEC}]      新着を待つ。届いたら出して終わる
  say    "本文" [--to <id>]  投稿する
  recent [-n 20]             直近の履歴を出す
  who                        参加者と状態を出す
  dump   [--out <path>]      JSONL に書き出す
  leave                      離脱を知らせる

サーバーの操作（管理者権限は要らない）:
  restart                    落として起動し直させる（ソース修正の反映に使う）
  stop                       止める。起動し直すには winsw の start が要る
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
await run();
