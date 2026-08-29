import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
	PORT, HOSTS, WEB_DIR, DEFAULT_ROOM, MAX_WAIT_SEC, OFFLINE_CHECK_MS,
	MAX_ID_LENGTH, MAX_BODY_LENGTH, DEFAULT_HISTORY_LIMIT,
	describeEnv, describeListen, VERSION, STARTED_AT,
} from './config.mjs';
import { log } from './log.mjs';
import {
	addMessage, getSince, getLatest, getBefore, getMaxSeq,
	joinUser, touchUser, addConnection, removeConnection, listRooms,
	getCursor, setCursor,
} from './store.mjs';
import { listPresence, getPresence, STATUS } from './presence.mjs';
import {
	waitForMessages, publish, publishPresence,
	addSseClient, removeSseClient, releaseAll,
} from './hub.mjs';

/** 入力の誤りを 400 で返すための例外 */
class BadRequest extends Error {}

// --- 入力の検証 ---

function requireId(value, name) {
	const id = String(value ?? '').trim();
	if (!id) throw new BadRequest(`${name} は必須です`);
	if (id.length > MAX_ID_LENGTH) throw new BadRequest(`${name} は ${MAX_ID_LENGTH} 文字までです`);
	return id;
}

function optionalId(value, name) {
	if (value === undefined || value === null || value === '') return null;
	return requireId(value, name);
}

function roomOf(value) {
	return optionalId(value, 'room_id') ?? DEFAULT_ROOM;
}

function requireBody(value) {
	const body = String(value ?? '');
	if (!body) throw new BadRequest('msg_body は必須です');
	if (body.length > MAX_BODY_LENGTH) throw new BadRequest(`msg_body は ${MAX_BODY_LENGTH} 文字までです`);
	return body;
}

function roleOf(value) {
	const role = String(value ?? 'ai');
	if (role !== 'ai' && role !== 'human') throw new BadRequest('user_role は ai か human です');
	return role;
}

/**
 * 数値として読む。省略されていたら fallback を返す。
 *
 * URL のクエリは省略されると null になり、Number(null) は 0 になってしまう。
 * これを素通しすると、wait を省略しただけで「0 秒待つ」ことになる。
 */
function numberOf(value, fallback) {
	if (value === null || value === undefined || value === '') return fallback;
	const n = Number(value);
	return Number.isFinite(n) ? n : fallback;
}

// --- 応答 ---

function sendJson(res, status, payload) {
	const text = JSON.stringify(payload);
	res.writeHead(status, {
		'Content-Type': 'application/json; charset=utf-8',
		'Content-Length': Buffer.byteLength(text),
		'Cache-Control': 'no-store',
	});
	res.end(text);
}

async function readJsonBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		// 本文の上限に多少の余裕を持たせた値。これを超えたら読むのをやめる
		if (size > MAX_BODY_LENGTH * 4) throw new BadRequest('本文が大きすぎます');
		chunks.push(chunk);
	}
	if (chunks.length === 0) return {};
	try {
		return JSON.parse(Buffer.concat(chunks).toString('utf8'));
	} catch {
		throw new BadRequest('JSON として読めません');
	}
}

// --- 在席の変化を知らせる ---

/** 直近に配った在席の状態。変化したときだけ SSE へ流す */
let lastPresenceJson = '';

function broadcastPresence() {
	const list = listPresence();
	const json = JSON.stringify(list);
	if (json === lastPresenceJson) return;
	lastPresenceJson = json;
	publishPresence(list);
}

/** システムメッセージを積んで配る */
function postSystemMessage(roomId, userId, kind, body) {
	const message = addMessage({ roomId, fromUserId: userId, kind, body });
	publish(message);
	return message;
}

/**
 * 直前に見たときの在席。offline へ落ちた瞬間を見つけるために覚えておく。
 * サーバーを起動し直すと空になるが、そのときは全員 offline から始まるので
 * 落ちたことにはならない（誤って離脱を流さない）。
 */
const knownStatus = new Map();

/**
 * 猶予を過ぎてオフラインになった人を見つけ、離脱をログに積む。
 *
 * 明示的な leave は本人が知らせてくれるが、待受けを張ったまま消えた場合や
 * 画面を閉じ損ねた場合は誰も知らせない。待受け中の AI はメッセージしか見て
 * いないため、ここで積まないと相手が居なくなったことに気づけない。
 */
export function sweepOffline() {
	const gone = [];
	for (const user of listPresence()) {
		const before = knownStatus.get(user.user_id);
		knownStatus.set(user.user_id, user.status);
		// 初めて見る相手は対象外。起動直後に全員分の離脱が流れるのを防ぐ
		if (before && before !== STATUS.OFFLINE && user.status === STATUS.OFFLINE) {
			gone.push(user.user_id);
		}
	}

	for (const userId of gone) {
		log.info(`${userId} がオフラインになりました`);
		// ルームごとの在席は持っていないため、既定のルームに積む
		postSystemMessage(DEFAULT_ROOM, userId, 'leave', `${userId} がオフラインになりました`);
	}
	if (gone.length > 0) broadcastPresence();
	return gone;
}

// --- 各エンドポイント ---

async function handleJoin(req, res) {
	const input = await readJsonBody(req);
	const userId = requireId(input.user_id, 'user_id');
	const role = roleOf(input.user_role);
	const roomId = roomOf(input.room_id);

	const before = getPresence(userId);
	joinUser(userId, role);

	// すでにオンラインだった相手の再接続では通知しない（張り直しのたびに流れてしまう）
	if (!before || before.status === STATUS.OFFLINE) {
		postSystemMessage(roomId, userId, 'join', `${userId} が参加しました`);
	}
	// 初めてのときだけ、参加した時点を読み始めの位置にする。
	// すでに読んでいる位置があれば触らない（未読を飛ばさないため）
	if (getCursor(userId, roomId) === null) setCursor(userId, roomId, getMaxSeq(roomId));

	broadcastPresence();

	sendJson(res, 200, {
		user_id: userId,
		room_id: roomId,
		msg_seq: getMaxSeq(roomId),
		users: listPresence(),
	});
}

async function handleSay(req, res) {
	const input = await readJsonBody(req);
	const fromUserId = requireId(input.from_user_id ?? input.user_id, 'from_user_id');
	const roomId = roomOf(input.room_id);
	const toUserId = optionalId(input.to_user_id, 'to_user_id');
	const body = requireBody(input.msg_body);

	touchUser(fromUserId);
	const message = addMessage({ roomId, fromUserId, kind: 'say', toUserId, body });
	publish(message);
	broadcastPresence();

	sendJson(res, 200, message);
}

async function handlePoll(req, res, url) {
	const userId = optionalId(url.searchParams.get('user_id'), 'user_id');
	const roomId = roomOf(url.searchParams.get('room_id'));
	const waitSec = Math.min(Math.max(numberOf(url.searchParams.get('wait'), MAX_WAIT_SEC), 0), MAX_WAIT_SEC);

	/*
	 * since を省略したら、サーバーが覚えている位置から続ける。
	 * クライアントが自分で位置を管理しなくて済み、実行した場所にも縛られない。
	 * 明示的に渡された場合はそちらを優先する（ブラウザは自分で管理している）。
	 */
	const sinceParam = url.searchParams.get('since');
	const since =
		sinceParam !== null && sinceParam !== ''
			? numberOf(sinceParam, 0)
			: userId
				? (getCursor(userId, roomId) ?? getMaxSeq(roomId))
				: 0;

	// 待っている間も在席とみなす。接続を保持しているので確実にいる
	if (userId) {
		touchUser(userId);
		addConnection(userId);
		broadcastPresence();
	}

	let closed = false;
	req.on('close', () => { closed = true; });

	try {
		const messages = await waitForMessages(roomId, since, waitSec * 1000);
		if (closed) return;

		const msgSeq = messages.length > 0 ? messages[messages.length - 1].msg_seq : since;
		// 返した分まで読んだものとして記録する。次は since を省略しても続きから受け取れる
		if (userId) setCursor(userId, roomId, msgSeq);

		sendJson(res, 200, { room_id: roomId, since, msg_seq: msgSeq, messages });
	} finally {
		if (userId) {
			removeConnection(userId);
			broadcastPresence();
		}
	}
}

function handleHistory(res, url) {
	const roomId = roomOf(url.searchParams.get('room_id'));
	const limit = numberOf(url.searchParams.get('limit'), DEFAULT_HISTORY_LIMIT);
	const beforeParam = url.searchParams.get('before');

	const messages = beforeParam
		? getBefore(roomId, numberOf(beforeParam, 0), limit)
		: getLatest(roomId, limit);

	sendJson(res, 200, { room_id: roomId, messages });
}

function handleUsers(res) {
	sendJson(res, 200, { users: listPresence() });
}

function handleRooms(res) {
	sendJson(res, 200, { rooms: listRooms(), default_room: DEFAULT_ROOM });
}

/**
 * サーバーの版。起動するたびに変わる。
 * ブラウザはこれを見て、中身が入れ替わったら自分を読み直す。
 */
function handleVersion(res) {
	sendJson(res, 200, { version: VERSION, started_at: STARTED_AT });
}

async function handleLeave(req, res) {
	const input = await readJsonBody(req);
	const userId = requireId(input.user_id, 'user_id');
	const roomId = roomOf(input.room_id);

	postSystemMessage(roomId, userId, 'leave', `${userId} が離脱しました`);
	broadcastPresence();

	sendJson(res, 200, { user_id: userId, left: true });
}

/**
 * 応答を返してからプロセスを終える。
 *
 * WinSW の onfailure は「異常終了したとき」にだけ再起動する。
 * 終了コード 0 は正常終了とみなされ、サービスは停止したままになる。
 * この違いをそのまま restart と stop に割り当てている。
 *
 * 管理者権限が要るのはサービスの登録・開始・停止であって、プロセスが自分で
 * 終わることには要らない。そのため、ソースを直したあとの反映を
 * 管理者権限なしで行える。
 */
function scheduleExit(res, code, payload) {
	sendJson(res, 200, payload);

	// テストから叩くときは実際に落とさない
	if (process.env.AICHAT_NO_EXIT === '1') {
		log.warn(`AICHAT_NO_EXIT=1 のため終了しません（本来なら終了コード ${code}）`);
		return;
	}

	// 応答が相手に届いてから終える
	setTimeout(() => {
		releaseAll();
		log.warn(`終了コード ${code} で終了します`);
		process.exit(code);
	}, 200);
}

/** WinSW 経由で動いているか。XML の <env> で渡している */
const MANAGED_BY = process.env.AICHAT_MANAGED ?? null;

/**
 * プロセスを終える。再起動するかどうかは終了コードで決まる。
 *
 * 既定を 1（再起動される側）にしているのは、取り違えたときの被害が小さいため。
 * 0 で止めてしまうと、動かし直すのに管理者権限が要る。
 */
async function handleExit(req, res, url) {
	// GET でも受ける。ブラウザのアドレスバーから直接叩けるようにするため。
	// 副作用のある GET は本来避けるところだが、localhost 限定で認証も無い前提なので
	// 手軽さを優先する。リンクとして書かないこと（先読みで落ちる）。
	const input =
		req.method === 'POST'
			? await readJsonBody(req)
			: {
					user_id: url.searchParams.get('user_id'),
					exit_code: url.searchParams.get('exit_code'),
				};
	const who = input.user_id ?? '不明';

	const code = Math.trunc(numberOf(input.exit_code, 1));
	if (!Number.isInteger(code) || code < 0 || code > 255) {
		throw new BadRequest('exit_code は 0〜255 の整数です');
	}

	const willRestart = code !== 0;
	log.warn(`終了の要求を受け取りました（要求元: ${who} / 終了コード ${code}）`);

	scheduleExit(res, code, {
		exit_code: code,
		will_restart: Boolean(MANAGED_BY) && willRestart,
		managed_by: MANAGED_BY,
		note: !MANAGED_BY
			? 'サービス経由ではないため、このまま終了します'
			: willRestart
				? '異常終了として扱われるため、10 秒後に起動し直します'
				: '正常終了として扱われるため、自動では起動し直しません',
	});
}

function handleEvents(req, res, url) {
	const userId = optionalId(url.searchParams.get('user_id'), 'user_id');
	const roomId = roomOf(url.searchParams.get('room_id'));
	const since = numberOf(url.searchParams.get('since'), null);

	res.writeHead(200, {
		'Content-Type': 'text/event-stream; charset=utf-8',
		'Cache-Control': 'no-store',
		Connection: 'keep-alive',
	});

	const client = {
		roomId,
		send(event, data) {
			res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
		},
	};
	addSseClient(client);

	if (userId) {
		touchUser(userId);
		addConnection(userId);
	}

	// 履歴を取ってから繋ぐまでの隙間に届いた分を、まず流す
	if (since !== null) {
		for (const message of getSince(roomId, since)) client.send('message', message);
	}
	// 版を先に伝える。前と違えばブラウザ側が読み直す
	client.send('version', { version: VERSION, started_at: STARTED_AT });
	client.send('presence', listPresence());
	broadcastPresence();

	// 経路の途中で切られないよう、無音が続いてもコメント行を送り続ける
	const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 25000);
	keepAlive.unref?.();

	req.on('close', () => {
		clearInterval(keepAlive);
		removeSseClient(client);
		if (userId) {
			removeConnection(userId);
			broadcastPresence();
		}
	});
}

// --- 静的ファイル ---

const CONTENT_TYPES = {
	'.html': 'text/html; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
};

async function handleStatic(res, pathname) {
	const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
	// .. を含むパスで WEB_DIR の外へ出られないようにする
	const full = normalize(join(WEB_DIR, rel));
	if (!full.startsWith(normalize(WEB_DIR))) {
		sendJson(res, 403, { error: '参照できません' });
		return;
	}
	try {
		const content = await readFile(full);
		res.writeHead(200, {
			'Content-Type': CONTENT_TYPES[extname(full)] ?? 'application/octet-stream',
			'Content-Length': content.length,
			'Cache-Control': 'no-store',
		});
		res.end(content);
	} catch {
		sendJson(res, 404, { error: '見つかりません', path: pathname });
	}
}

// --- ルーティング ---

export async function handleRequest(req, res) {
	const url = new URL(req.url, 'http://localhost');
	const path = url.pathname;

	try {
		if (req.method === 'POST') {
			if (path === '/api/join') return await handleJoin(req, res);
			if (path === '/api/say') return await handleSay(req, res);
			if (path === '/api/leave') return await handleLeave(req, res);
			// 落とす。うっかり叩かないよう /api/admin/ に分けている
			if (path === '/api/admin/exit') return await handleExit(req, res, url);
		}
		if (req.method === 'GET') {
			if (path === '/api/poll') return await handlePoll(req, res, url);
			if (path === '/api/history') return handleHistory(res, url);
			if (path === '/api/users') return handleUsers(res);
			if (path === '/api/rooms') return handleRooms(res);
			if (path === '/api/version') return handleVersion(res);
			if (path === '/api/events') return handleEvents(req, res, url);
			// ブラウザのアドレスバーから叩けるよう GET も受ける
			if (path === '/api/admin/exit') return await handleExit(req, res, url);
			if (!path.startsWith('/api/')) return await handleStatic(res, path);
		}
		sendJson(res, 404, { error: '該当するものがありません', path });
	} catch (err) {
		if (err instanceof BadRequest) {
			sendJson(res, 400, { error: err.message });
			return;
		}
		// CHECK 制約に引っかかった場合もここに来る。原因は入力にあることが多い
		if (String(err?.message ?? '').includes('CHECK constraint failed')) {
			log.warn(`入力が制約に合いません: ${err.message}`);
			sendJson(res, 400, { error: '入力が受け付けられません', detail: err.message });
			return;
		}
		log.error(`${req.method} ${path}: ${err?.stack ?? err}`);
		if (!res.headersSent) sendJson(res, 500, { error: '内部エラー' });
	}
}

// --- 起動 ---

/**
 * 待ち受けを開始する。
 * localhost は ::1 と 127.0.0.1 の両方を指すため、両方で listen する。
 * 片方だけに bind すると、もう一方から来た接続が拒否される。
 */
export async function startServers(port = PORT, hosts = HOSTS) {
	const servers = await Promise.all(
		hosts.map(
			(host) =>
				new Promise((resolve, reject) => {
					const server = createServer(handleRequest);
					server.on('error', reject);
					server.listen(port, host, () => resolve(server));
				})
		)
	);

	// オフラインへ落ちた人を定期的に見つける
	offlineTimer = setInterval(sweepOffline, OFFLINE_CHECK_MS);
	offlineTimer.unref?.();

	return servers;
}

let offlineTimer = null;

export function stopServers(servers) {
	if (offlineTimer) {
		clearInterval(offlineTimer);
		offlineTimer = null;
	}
	releaseAll();
	return Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
}

// 直接実行されたときだけ起動する（テストから読み込むときは起動しない）。
// Windows のパスを file:// に手で組み立てるとドライブレターが host 扱いになるため、
// pathToFileURL に任せる。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	log.info(`ai-chat-lite サーバーを起動しました（版 ${VERSION}）`);
	for (const line of describeEnv()) log.info(line);
	log.info(describeListen());

	const servers = await startServers();
	log.info(`待ち受けを開始しました（${servers.length} 個のアドレス）`);

	for (const signal of ['SIGINT', 'SIGTERM']) {
		process.on(signal, async () => {
			log.info(`${signal} を受け取りました。終了します`);
			await stopServers(servers);
			process.exit(0);
		});
	}
}
