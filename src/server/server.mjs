import { sendJson, serveStatic } from './serve.mjs';
import { startListening, setHandler, closeListening } from './listen.mjs';

import {
	PORT, HOSTS, DEFAULT_ROOM, MAX_WAIT_SEC, OFFLINE_CHECK_MS,
	MAX_ID_LENGTH, MAX_BODY_LENGTH, DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT,
	VERSION, STARTED_AT, IS_TEST, TEST_ACCESS_TOKEN,
} from './config.mjs';
import { log } from './log.mjs';
import { nowJst } from './time.mjs';
import {
	addMessage, getSince, getLatest, getBefore, getFiltered, getMaxSeq,
	joinConnector, touchConnector, addConnection, removeConnection, listRooms,
	getCursor, setCursor, closeDb, getConnector,
	previewArchive, archive, restore, listArchives, getAllMessages,
	previewRename, renameConnector,
} from './store.mjs';
import { listPresence, getPresence, STATUS } from './presence.mjs';
import { ID_PATTERN } from '../client/options.mjs';
import { rejectionReason } from './names.mjs';
import {
	waitForMessages, publish, publishPresence,
	addSseClient, removeSseClient, releaseAll,
} from './hub.mjs';

/** 入力の誤りを 400 で返すための例外 */
class BadRequest extends Error {}

/**
 * サーバー自身が案内を出すときに名乗る名前。
 *
 * 「名乗る ID は project フォルダ名」という決まりに沿う。すでに参加者にいるので
 * 一覧が増えない。専用の名前（server 等）にすると、接続を持たない参加者が
 * 常にオフラインとして一覧に残り続ける。
 */
const SERVER_ID = 'ai-chat-lite';

// --- 入力の検証 ---

/**
 * ID として受け取れる文字。参加者の ID とルーム ID の両方に効かせる。
 *
 * CLI 側でも同じ検査をしているが、ここにも置く。CLI だけだと web UI や
 * curl から直に叩いた分が抜ける。逆にサーバーだけだと、往復してからでないと
 * 誤りが分からない。両方に置いて、早く弾きつつ漏らさない形にする。
 *
 * DB の CHECK 制約にはしない。いまの CHECK は長さだけで、文字種を足すと
 * CHECK の変更＝テーブルの作り直しになる。得るものに対して重すぎる。
 *
 * 規則は src/client/options.mjs の ID_PATTERN を見る。CLI と食い違わないよう、
 * 出どころを 1 か所にする。
 */
const ID_RE = new RegExp(ID_PATTERN);

function requireId(value, name) {
	const id = String(value ?? '').trim();
	if (!id) throw new BadRequest(`${name} は必須です`);
	if (id.length > MAX_ID_LENGTH) throw new BadRequest(`${name} は ${MAX_ID_LENGTH} 文字までです`);
	if (!ID_RE.test(id)) {
		throw new BadRequest(`${name} に使えるのは英数字・ハイフン・下線・ピリオド（先頭と末尾には置けません）だけです: ${id}`);
	}
	return id;
}

function optionalId(value, name) {
	if (value === undefined || value === null || value === '') return null;
	return requireId(value, name);
}

function roomOf(value) {
	return optionalId(value, 'room_id') ?? DEFAULT_ROOM;
}

/**
 * ルームをカンマ区切りで受け、配列にする。
 *
 * 1 つだけ渡せば今までと同じ結果になる。区切りを exclude と同じカンマにしたのは、
 * 書き方を 2 つ持たないため。重複は落とす。
 */
function roomsOf(value) {
	const raw = String(value ?? '').trim();
	if (!raw) return [DEFAULT_ROOM];
	const seen = new Set();
	for (const part of raw.split(',')) seen.add(requireId(part.trim(), 'room_id'));
	return [...seen];
}

/**
 * 本番では、テスト用の名前で繋がせない。判定は names.mjs が持つ。
 *
 * どちらの環境かを知っているのはサーバーだけなので、ここで断る。
 */
function rejectTestNames(connectorId, roomId) {
	const reason = rejectionReason(connectorId, roomId, IS_TEST);
	if (reason) throw new BadRequest(reason);
}

/**
 * 返信先の msg_seq を読む。渡されなければ null。
 *
 * 【存在は確かめない】
 * 指す先が片付けられていることがある。存在を強いると、返信が付いた発言を
 * 片付けられなくなる。画面は指す先が無ければ引用を出さないだけにする。
 * 確かめるのは「1 以上の整数であること」までにする。
 */
function optionalMsgSeq(value) {
	if (value === undefined || value === null || value === '') return null;
	const n = Number(value);
	if (!Number.isInteger(n) || n < 1) {
		throw new BadRequest(`reply_to_msg_seq は 1 以上の整数です: ${value}`);
	}
	return n;
}

function requireBody(value) {
	const body = String(value ?? '');
	if (!body) throw new BadRequest('msg_body は必須です');
	if (body.length > MAX_BODY_LENGTH) throw new BadRequest(`msg_body は ${MAX_BODY_LENGTH} 文字までです`);
	return body;
}

function roleOf(value) {
	const role = String(value ?? 'ai');
	if (role !== 'ai' && role !== 'human') throw new BadRequest('connector_role は ai か human です');
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

/** messages.msg_kind に入る値。版の SQL の CHECK と同じ並び */
const MSG_KINDS = ['say', 'join', 'leave', 'archive', 'notice'];

/*
 * SSE で繋ぎ直したときに、まとめて流す上限。
 *
 * これを超える分は流さず、truncated を送って画面に履歴を取り直させる。
 * 全部流すと、長く切れていた 1 人のために大量の書き込みが続く
 */
export const SSE_CATCHUP_MAX = 2000;

/**
 * 待受けを起こさない msg_kind を読む。省略されていたら空（全部で起こす）。
 *
 * 知らない名前は断る。素通しすると「除いたつもりで除けていない」状態になり、
 * 呼ぶ側は待受けが起きる理由を追えない。綴りの間違いは黙って通さない。
 */
function excludeOf(value) {
	if (value === null || value === undefined || value === '') return new Set();
	const kinds = String(value)
		.split(',')
		.map((s) => s.trim())
		.filter((s) => s !== '');
	for (const kind of kinds) {
		if (!MSG_KINDS.includes(kind)) {
			throw new BadRequest(`exclude に使えるのは ${MSG_KINDS.join(' ')} です: ${kind}`);
		}
	}
	return new Set(kinds);
}

// --- 応答 ---


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

/*
 * システムメッセージを積んで配る。
 *
 * refArchivedSeq は片付け・戻しの通知だけが持つ。どの操作を指しているかを
 * 本文とは別に残しておくと、画面がその場で戻すボタンを出せる。本文は
 * --description で書き換えられるため、番号を本文から拾うことはできない。
 */
function postSystemMessage(roomId, connectorId, kind, body, refArchivedSeq = null) {
	const message = addMessage({ roomId, fromConnectorId: connectorId, kind, body, refArchivedSeq });
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
	for (const c of listPresence()) {
		const before = knownStatus.get(c.connector_id);
		knownStatus.set(c.connector_id, c.status);
		// 初めて見る相手は対象外。起動直後に全員分の離脱が流れるのを防ぐ
		if (before && before !== STATUS.OFFLINE && c.status === STATUS.OFFLINE) {
			gone.push(c.connector_id);
		}
	}

	for (const connectorId of gone) {
		log.info(`${connectorId} がオフラインになりました`);
		// ルームごとの在席は持っていないため、既定のルームに積む
		postSystemMessage(DEFAULT_ROOM, connectorId, 'leave', `${connectorId} がオフラインになりました`);
	}
	if (gone.length > 0) broadcastPresence();
	return gone;
}

// --- 各エンドポイント ---

async function handleJoin(req, res) {
	const input = await readJsonBody(req);
	const connectorId = requireId(input.connector_id, 'connector_id');
	const role = roleOf(input.connector_role);
	const roomId = roomOf(input.room_id);
	rejectTestNames(connectorId, roomId);

	const before = getPresence(connectorId);
	joinConnector(connectorId, role);

	// すでにオンラインだった相手の再接続では通知しない（張り直しのたびに流れてしまう）
	if (!before || before.status === STATUS.OFFLINE) {
		postSystemMessage(roomId, connectorId, 'join', `${connectorId} が参加しました`);
	}
	// 初めてのときだけ、参加した時点を読み始めの位置にする。
	// すでに読んでいる位置があれば触らない（未読を飛ばさないため）
	if (getCursor(connectorId, roomId) === null) setCursor(connectorId, roomId, getMaxSeq(roomId));

	broadcastPresence();

	sendJson(res, 200, {
		connector_id: connectorId,
		room_id: roomId,
		msg_seq: getMaxSeq(roomId),
		connectors: listPresence(),
	});
}

async function handleSay(req, res) {
	const input = await readJsonBody(req);
	const fromConnectorId = requireId(input.from_connector_id ?? input.connector_id, 'from_connector_id');
	const roomId = roomOf(input.room_id);
	const toConnectorId = optionalId(input.to_connector_id, 'to_connector_id');
	rejectTestNames(fromConnectorId, roomId);
	const body = requireBody(input.msg_body);
	const replyToMsgSeq = optionalMsgSeq(input.reply_to_msg_seq);

	touchConnector(fromConnectorId);
	const message = addMessage({ roomId, fromConnectorId, kind: 'say', toConnectorId, body, replyToMsgSeq });
	publish(message);
	broadcastPresence();

	sendJson(res, 200, message);
}

async function handlePoll(req, res, url) {
	const connectorId = optionalId(url.searchParams.get('connector_id'), 'connector_id');
	const rooms = roomsOf(url.searchParams.get('room_id'));
	const waitSec = Math.min(Math.max(numberOf(url.searchParams.get('wait'), MAX_WAIT_SEC), 0), MAX_WAIT_SEC);
	const exclude = excludeOf(url.searchParams.get('exclude'));
	for (const roomId of rooms) rejectTestNames(connectorId, roomId);

	/*
	 * since を省略したら、サーバーが覚えている位置から続ける。
	 * クライアントが自分で位置を管理しなくて済み、実行した場所にも縛られない。
	 * 明示的に渡された場合はそちらを優先する（ブラウザは自分で管理している）。
	 *
	 * ただし since は数 1 つなので、複数のルームを表せない。受け付けたままにすると
	 * 片方の番号でもう片方を読むことになり、取りこぼしか読み直しが起きる。断る。
	 */
	const sinceParam = url.searchParams.get('since');
	const hasSince = sinceParam !== null && sinceParam !== '';
	if (hasSince && rooms.length > 1) {
		throw new BadRequest('複数のルームを待つときは since を渡せません（サーバーが覚えている位置から続きます）');
	}

	const sinceByRoom = new Map();
	for (const roomId of rooms) {
		sinceByRoom.set(
			roomId,
			hasSince
				? numberOf(sinceParam, 0)
				: connectorId
					? (getCursor(connectorId, roomId) ?? getMaxSeq(roomId))
					: 0,
		);
	}

	// 待っている間も在席とみなす。接続を保持しているので確実にいる
	let counted = false;
	if (connectorId) {
		touchConnector(connectorId);
		addConnection(connectorId);
		counted = true;
		broadcastPresence();
	}

	/*
	 * 数えた接続を戻す。切れたときと、待ち終えたときの両方から呼ぶ。
	 *
	 * close で印を付けるだけにしていたため、実際に減るのは待ち終えた後の
	 * finally だった。そのルームに新着が無ければ最大 240 秒はそのまま数えられ、
	 * オフラインになるのは猶予 90 秒を足した 330 秒後になっていた。
	 * 「90 秒でオフライン」を読んだ側は、相手の生死を読み違える。
	 *
	 * 二重に減らさないよう counted で守る。MAX(0, …) でも下限は守られるが、
	 * それに頼ると別の接続の分まで食う
	 */
	const release = () => {
		if (!counted) return;
		counted = false;
		removeConnection(connectorId);
		broadcastPresence();
	};

	/*
	 * 切れたら待機もやめる。印を付けるだけにすると、相手がいないのに
	 * 時間切れまで（既定 240 秒）待機が居座る。
	 */
	let closed = false;
	const cancel = new AbortController();
	req.on('close', () => {
		closed = true;
		release();
		cancel.abort();
	});

	try {
		const { messages, scanned } = await waitForMessages(
			rooms,
			sinceByRoom,
			waitSec * 1000,
			exclude,
			cancel.signal
		);
		if (closed) return;

		/*
		 * 走査した所まで読んだものとして記録する。次は since を省略しても続きから届く。
		 *
		 * 除いた分も進める。止めると、張り直した先で同じ join を読み、また除いて待つ。
		 * 1 回で済むはずの走査が毎回積み上がる。
		 *
		 * 位置はルームごとに持つ。片方に届いても、もう片方の位置は動かさない。
		 */
		const roomsOut = rooms.map((roomId) => {
			const since = sinceByRoom.get(roomId);
			const msgSeq = Math.max(scanned.get(roomId) ?? since, since);
			if (connectorId) setCursor(connectorId, roomId, msgSeq);
			return { room_id: roomId, since, msg_seq: msgSeq };
		});

		// 1 つだけのときは、これまでと同じ形も添える。既存の呼び出しを壊さないため
		const body = { rooms: roomsOut, messages };
		if (roomsOut.length === 1) {
			body.room_id = roomsOut[0].room_id;
			body.since = roomsOut[0].since;
			body.msg_seq = roomsOut[0].msg_seq;
		}
		sendJson(res, 200, body);
	} finally {
		release();
	}
}

/**
 * sent_at と同じ形（yyyy/mm/dd HH:MM:SS.mmm 固定 23 文字）かを確かめて返す。
 *
 * CLI 側（node 版・C# 版とも）は、期間の書式・未来への丸めを解決したあと
 * 必ずこの形にして渡す。ここでは形だけを見る（値の意味までは踏み込まない）。
 * 直に叩かれたときのために、サーバー側でも軽く確かめておく。
 */
const SENT_AT_RE = /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/;

function tsParam(url, name) {
	const raw = url.searchParams.get(name);
	if (!raw) return null;
	if (!SENT_AT_RE.test(raw)) throw new BadRequest(`${name} の形が正しくありません（yyyy/mm/dd HH:MM:SS.mmm）: ${raw}`);
	return raw;
}

function handleHistory(res, url) {
	const roomId = roomOf(url.searchParams.get('room_id'));
	const limit = numberOf(url.searchParams.get('limit'), DEFAULT_HISTORY_LIMIT);
	const beforeParam = url.searchParams.get('before');
	const sinceTs = tsParam(url, 'since_ts');
	const beforeTs = tsParam(url, 'before_ts');
	const find = url.searchParams.get('find') || null;
	const fromConnectorId = optionalId(url.searchParams.get('from_connector_id'), 'from_connector_id');

	/*
	 * 新しい絞り込み（since_ts・before_ts・find・from_connector_id）のどれか 1 つでも
	 * あれば getFiltered を使う。無ければ今までどおり（before は msg_seq のページ送り）。
	 * 既存の呼び出しはこの4つを渡さないので、今までと同じ経路のまま動く。
	 */
	const messages =
		sinceTs || beforeTs || find || fromConnectorId
			? getFiltered(roomId, { sinceTs, beforeTs, find, from: fromConnectorId, limit })
			: beforeParam
				? getBefore(roomId, numberOf(beforeParam, 0), limit)
				: getLatest(roomId, limit);

	sendJson(res, 200, { room_id: roomId, messages });
}

/**
 * その connector が、渡したルームのどれかで「初めての接続」かを返す。
 *
 * wait の起動時に出す案内（i260909-01）に使う。読むだけで、setCursor は
 * 呼ばない（poll と違い、待たない・進めない）。何度呼んでも同じ答えを返す。
 */
function handleCursorStatus(res, url) {
	const connectorId = requireId(url.searchParams.get('connector_id'), 'connector_id');
	const rooms = roomsOf(url.searchParams.get('room_id'));
	const roomsOut = rooms.map((roomId) => ({ room_id: roomId, first_time: getCursor(connectorId, roomId) === null }));
	sendJson(res, 200, { rooms: roomsOut, first_time: roomsOut.some((r) => r.first_time) });
}

/**
 * 全件を書き出す。ルームで絞らず、片付けたものも含める。
 *
 * /api/history とは用途が違う。history は読むための道で、片付けたものを
 * 出さない絞り込みがそこに掛かっている。同じ入口に「含める」旗を足すと、
 * 旗の付け忘れ・付きすぎで結果が変わる経路が読む道の中にできてしまう。
 *
 * こちらは中身を目視・grep するためのもの。archived_seq も一緒に返すので、
 * どれが片付けられたものかは受け取った側で分かる。
 */
function handleDump(res) {
	const messages = getAllMessages();
	sendJson(res, 200, { messages, count: messages.length });
}

function handleConnectors(res) {
	sendJson(res, 200, { connectors: listPresence() });
}

function handleRooms(res) {
	sendJson(res, 200, { rooms: listRooms(), default_room: DEFAULT_ROOM });
}

/*
 * どちらの環境として動いているか。
 *
 * 繋いだ側が自分の居場所を確かめられるようにする。テストは投稿の直前にこれを見て、
 * 本番だったら投稿せずに止まる。画面はこれで色を変える。
 */
const ENV_NAME = IS_TEST ? 'test' : 'production';

/**
 * サーバーの版。起動するたびに変わる。
 * ブラウザはこれを見て、中身が入れ替わったら自分を読み直す。
 */
function handleVersion(res) {
	// 通常の応答に切り替わっているのでメンテナンス中ではない。
	// 項目の形をメンテナンス中と揃えておくと、読む側が分岐せずに済む
	sendJson(res, 200, {
		version: VERSION,
		started_at: STARTED_AT,
		env: ENV_NAME,
		maintenance: false,
		maintenance_since: '',
		maintenance_reason: '',
	});
}

/**
 * 離脱を知らせる。ただし、すぐには積まない。
 *
 * ブラウザは pagehide で /api/leave を送るが、この行事は画面を閉じたときだけで
 * なく「リロード」でも起きる。呼ばれた時点で積むと、リロードのたびに
 * 「離脱しました」が並ぶ（実測でリロード 3 回につき 3 件）。
 *
 * pagehide からは閉じたのかリロードなのか区別できない。区別できるのは
 * サーバー側で、少し待って接続が戻ってくるかを見ればよい。リロードなら
 * 1 秒ほどで繋ぎ直す。
 *
 * 検討した他の案:
 *   案C 積むのをやめ、sweepOffline() だけに任せる。単純だが、閉じてから
 *       記録されるまで猶予の 90 秒がかかる
 *   案E ブラウザが sessionStorage に印を置き、次の onload で 5 秒以内なら
 *       リロードだったと判断する。ただし pagehide の時点で送信は済んでおり、
 *       判定できるのは積まれた後になる。本当に閉じた場合は onload が来ないため
 *       送る機会も失う
 */
const LEAVE_GRACE_MS = Number(process.env.AICHAT_LEAVE_GRACE_MS ?? 5000);

async function handleLeave(req, res) {
	const input = await readJsonBody(req);
	const connectorId = requireId(input.connector_id, 'connector_id');
	const roomId = roomOf(input.room_id);
	rejectTestNames(connectorId, roomId);

	// 在席の表示だけは即座に変える。記録を待たせるのは積む判断だけ
	broadcastPresence();

	const timer = setTimeout(() => {
		// 戻ってきていれば何もしない。リロードや繋ぎ直しがこれに当たる
		const found = getConnector(connectorId);
		if (found && found.active_connection_count > 0) return;

		postSystemMessage(roomId, connectorId, 'leave', `${connectorId} が離脱しました`);
		broadcastPresence();
	}, LEAVE_GRACE_MS);
	// 終了を妨げない。落とすときに残っていても構わない
	timer.unref?.();

	sendJson(res, 200, { connector_id: connectorId, left: true, grace_ms: LEAVE_GRACE_MS });
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

		/*
		 * DB を閉じてから終える。閉じないと WAL の内容が本体に統合されず、
		 * chat.db-wal と chat.db-shm が残る。しかも発言の大半はその -wal 側に
		 * 残るため、chat.db だけを持ち出しても中身が空になる。
		 * 実測では、閉じれば 3 ファイルが 1 つにまとまり、閉じなければ
		 * 4 KB の本体と 2.2 MB の -wal が残った。
		 */
		try {
			closeDb();
		} catch (err) {
			// 閉じられなくても終了は続ける。次の起動で SQLite が復旧する
			log.error(`DB を閉じられませんでした: ${err?.message ?? err}`);
		}

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
// --- 片付ける（archive） ---

/** 片付けられる対象の種類 */
const ARCHIVE_KINDS = new Set(['message', 'connector', 'room']);

/**
 * 片付けたことを説明する文を組み立てる。
 *
 * 毎回入力を求めない。求めると面倒で、結局は中身のない文字列が並ぶ。
 * --description で書き換えられる。
 */
function describeArchive(kind, id, counts, byConnectorId) {
	const when = nowJst().slice(0, 16);
	const label = { message: '発言', connector: '参加者', room: 'ルーム' }[kind];
	const detail =
		kind === 'message'
			? `（msg_seq ${id}）`
			: kind === 'room'
				? `（発言 ${counts.messages} 件 / 読んだ位置 ${counts.cursors} 件）`
				: counts.messages > 0
					? `（発言 ${counts.messages} 件も含む）`
					: '（発言は残す）';

	return `${when} に ${byConnectorId} が ${label} ${id} を片付けた${detail}`;
}

async function handleArchive(req, res) {
	const input = await readJsonBody(req);
	const kind = String(input.kind ?? '');
	if (!ARCHIVE_KINDS.has(kind)) throw new BadRequest('kind は message / connector / room です');

	const id = requireId(input.id, 'id');
	const byConnectorId = requireId(input.connector_id, 'connector_id');
	const withMessages = Boolean(input.with_messages);

	/*
	 * 既定のルームは片付けられない。
	 *
	 * 参加時の行き先になっているため、片付けると誰も参加できなくなる。
	 */
	if (kind === 'room' && id === DEFAULT_ROOM) {
		throw new BadRequest(`${DEFAULT_ROOM} は片付けられません（参加時の行き先です）`);
	}

	/*
	 * confirm に対象の名前を求める。
	 *
	 * スクリプトからの誤爆を防ぐため。y や true では通さない。
	 */
	if (String(input.confirm ?? '') !== id) {
		throw new BadRequest(`confirm に "${id}" を入れてください（誤って片付けるのを防ぐため）`);
	}

	const counts = previewArchive(kind, id, withMessages);
	if (counts.messages + counts.cursors + counts.connectors === 0) {
		throw new BadRequest(`片付けるものがありません: ${kind} ${id}`);
	}

	const description = String(input.description ?? '').trim() || describeArchive(kind, id, counts, byConnectorId);
	if (description.length > 200) throw new BadRequest('description は 200 文字までです');

	const result = archive({ kind, id, withMessages, byConnectorId, description });

	// 後から「消えている」と気づいたときに経緯を追えるようにする
	log.warn(`片付けました（archived_seq ${result.archived_seq}）: ${description}`);

	/*
	 * 黙って消えると、他の参加者は何が起きたか分からない。
	 *
	 * 片付けたルーム自身に積んでも見えなくなるため、既定のルームに積む。
	 */
	postSystemMessage(DEFAULT_ROOM, byConnectorId, 'archive', description, result.archived_seq);
	broadcastPresence();

	sendJson(res, 200, result);
}

async function handleRestore(req, res) {
	const input = await readJsonBody(req);
	const seq = Math.trunc(numberOf(input.archived_seq, NaN));
	if (!Number.isInteger(seq) || seq < 1) throw new BadRequest('archived_seq は 1 以上の整数です');

	const byConnectorId = requireId(input.connector_id, 'connector_id');
	const result = restore(seq);
	if (!result) throw new BadRequest(`archived_seq ${seq} はありません`);

	log.warn(`戻しました（archived_seq ${seq} / ${result.restored} 件）: ${result.row.description}`);
	postSystemMessage(
		DEFAULT_ROOM,
		byConnectorId,
		'archive',
		`${nowJst().slice(0, 16)} に ${byConnectorId} が archived_seq ${seq} を戻した（${result.restored} 件）`
	);
	broadcastPresence();

	sendJson(res, 200, { archived_seq: seq, restored: result.restored, description: result.row.description });
}

function handleArchives(res) {
	sendJson(res, 200, { archives: listArchives() });
}

async function handleArchivePreview(req, res, url) {
	const kind = String(url.searchParams.get('kind') ?? '');
	if (!ARCHIVE_KINDS.has(kind)) throw new BadRequest('kind は message / connector / room です');
	const id = requireId(url.searchParams.get('id'), 'id');
	const withMessages = url.searchParams.get('with_messages') === '1';

	sendJson(res, 200, { kind, id, ...previewArchive(kind, id, withMessages) });
}

/**
 * 付け替える前に、何が書き換わるかを数える。
 *
 * 居ない ID は 400 で断る。0 件のまま名前を打たせても、打ち終えてから
 * 「対象がありません」と言われるだけになる。
 */
function handleRenamePreview(res, url) {
	const from = requireId(url.searchParams.get('from'), 'from');
	const counts = previewRename(from);
	const total =
		counts.connectors + counts.cursors + counts.messages_from + counts.messages_to +
		counts.archives + counts.archive_targets;
	if (total === 0) throw new BadRequest(`その ID の記録がありません: ${from}`);

	sendJson(res, 200, { from, ...counts });
}

/**
 * 参加者の ID を付け替える（i260909-02）。
 *
 * ID は 4 つのテーブルに散っている。手で SQL を書くと洗い出しから毎回やり直しに
 * なり、漏らすと「発言は見えるのに一覧にいない」「読んだ位置を失う」形で表に出る。
 */
async function handleRename(req, res) {
	const input = await readJsonBody(req);
	const from = requireId(input.from, 'from');
	const to = requireId(input.to, 'to');
	const byConnectorId = requireId(input.connector_id, 'connector_id');

	// 本番でテスト用の名前を名乗らせない。付け替えも新規参加と同じ扱いにする
	rejectTestNames(to, DEFAULT_ROOM);

	if (from === to) throw new BadRequest(`同じ ID には付け替えられません: ${from}`);

	/*
	 * confirm に旧 ID を求める。スクリプトからの誤爆を防ぐため（archive と同じ）。
	 */
	if (String(input.confirm ?? '') !== from) {
		throw new BadRequest(`confirm に "${from}" を入れてください（誤って付け替えるのを防ぐため）`);
	}

	/*
	 * 待受けが走っている間は断る。
	 *
	 * 走らせたまま付け替えると、その待受けは古い ID で poll し続け、新しい ID の
	 * カーソルを見ない。サーバーは古い ID の位置を進めないので、届いているつもりで
	 * 届かない状態になる。先に止めてもらう。
	 */
	const connector = getConnector(from);
	if (connector && Number(connector.active_connection_count) > 0) {
		throw new BadRequest(
			`${from} は待受け（または接続）が ${connector.active_connection_count} 本走っています。止めてから付け替えてください`
		);
	}

	/*
	 * store が投げるのは入力の誤り（新しい ID が使われている・同じ ID）なので、
	 * 500 ではなく 400 で返す。500 だと呼ぶ側が「サーバーの不具合」と読む。
	 */
	let result;
	try {
		result = renameConnector(from, to);
	} catch (err) {
		throw new BadRequest(err.message);
	}
	if (!result) throw new BadRequest(`その ID の記録がありません: ${from}`);

	// 後から「名前が変わっている」と気づいたときに経緯を追えるようにする
	log.warn(`付け替えました（${from} → ${to}）`);

	/*
	 * 黙って変わると、他の参加者は同じ相手だと分からない。
	 * 片付け（archive）と同じく、既定のルームに知らせを積む。
	 *
	 * 【自己改名では、知らせも新しい ID から出す】
	 * 書式は rename :<自分のID>: connector :<旧>: :<新>: で、自分の ID を自分で
	 * 付け替えるのが主用途である。名乗った ID をそのまま差出人にすると、
	 * 付け替えた直後に旧 ID の発言を 1 件だけ新たに積むことになる。
	 * postSystemMessage は connectors を見ずに messages へ素通しするので、
	 * store.mjs が挙げる失敗形「発言は見えるのに参加者一覧にいない」を
	 * rename 自身の手で作ってしまう。previewRename(旧 ID) も 1 件返すため、
	 * 実体の無い旧 ID をもう一度 rename できる状態になる
	 * （レビュー #22 medium 5。実測で再現した）。
	 */
	const noticeFrom = byConnectorId === from ? to : byConnectorId;
	postSystemMessage(
		DEFAULT_ROOM,
		noticeFrom,
		'archive',
		`${nowJst().slice(0, 16)} に ${noticeFrom} が 参加者 ${from} を ${to} に付け替えた`
	);
	broadcastPresence();

	sendJson(res, 200, { from, to, ...result });
}

async function handleExit(req, res, url) {
	// GET でも受ける。ブラウザのアドレスバーから直接叩けるようにするため。
	// 副作用のある GET は本来避けるところだが、localhost 限定で認証も無い前提なので
	// 手軽さを優先する。リンクとして書かないこと（先読みで落ちる）。
	const input =
		req.method === 'POST'
			? await readJsonBody(req)
			: {
					connector_id: url.searchParams.get('connector_id'),
					exit_code: url.searchParams.get('exit_code'),
				};
	const who = input.connector_id ?? '不明';

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
	const connectorId = optionalId(url.searchParams.get('connector_id'), 'connector_id');
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

	if (connectorId) {
		touchConnector(connectorId);
		addConnection(connectorId);
	}

	/*
	 * 履歴を取ってから繋ぐまでの隙間に届いた分を、まず流す。
	 *
	 * getSince は 1 回で MAX_HISTORY_LIMIT（500）件までしか返さない。1 回だけ
	 * 呼んでいたため、切れている間に 500 件を超えると、その先が永久に届かなかった。
	 * 画面は開いた時点の since を URL に焼き付けるので、繋ぎ直しても同じ所から
	 * 500 件で切れる。読み飛ばしと区別できず、見ている側は欠けに気づけない。
	 *
	 * 500 件ずつ進めて追いつく。多すぎるときは打ち切り、画面に読み直させる
	 */
	if (since !== null) {
		let cursor = Number(since) || 0;
		let sent = 0;
		for (;;) {
			const batch = getSince(roomId, cursor);
			if (batch.length === 0) break;
			for (const message of batch) client.send('message', message);
			sent += batch.length;
			cursor = batch[batch.length - 1].msg_seq;
			// 1 回分に満たなければ追いついた
			if (batch.length < MAX_HISTORY_LIMIT) break;
			if (sent >= SSE_CATCHUP_MAX) {
				/*
				 * バッチが満杯のまま上限に達した。ここで無条件に打ち切ると、
				 * 滞留がちょうど上限で終わっている場合まで truncated を送って
				 * しまう（満杯かどうかだけでは続きの有無が分からない）。
				 * 1 件だけ覗いて、本当に続きがあるときだけ送る
				 */
				if (getSince(roomId, cursor, 1).length > 0) {
					client.send('truncated', { from: cursor, sent });
				}
				break;
			}
		}
	}
	// 版を先に伝える。前と違えばブラウザ側が読み直す
	client.send('version', { version: VERSION, started_at: STARTED_AT, env: ENV_NAME });
	client.send('presence', listPresence());
	broadcastPresence();

	// 経路の途中で切られないよう、無音が続いてもコメント行を送り続ける
	const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 25000);
	keepAlive.unref?.();

	req.on('close', () => {
		clearInterval(keepAlive);
		removeSseClient(client);
		if (connectorId) {
			removeConnection(connectorId);
			broadcastPresence();
		}
	});
}

/**
 * テスト用として立っているとき、アクセストークンを持たない相手を断る。
 *
 * 他プロジェクトがポートを見つけて繋いでくると、テスト中のデータに他人の発言が
 * 混ざる。本番では何も求めない（IS_TEST が false のときは素通り）ので、
 * 他プロジェクトの使い方は変わらない。
 *
 * /api/version だけは通す。繋ぐ前に「ここはテスト用だ」と知るための入口で、
 * ここを閉じると取り違えに気づけない。
 */
function isAllowed(url, req) {
	if (!IS_TEST) return true;
	if (url.pathname === '/api/version') return true;

	// SSE（EventSource）はヘッダを付けられないため、クエリも見る
	return (
		req.headers['x-aichat-access-token'] === TEST_ACCESS_TOKEN ||
		url.searchParams.get('access_token') === TEST_ACCESS_TOKEN
	);
}

export async function handleRequest(req, res) {
	const url = new URL(req.url, 'http://localhost');
	const path = url.pathname;

	// 画面（HTML・CSS・JS）はアクセストークンなしで返す。開いた先でアクセストークンを受け取る
	if (path.startsWith('/api/') && !isAllowed(url, req)) {
		sendJson(res, 403, { error: 'テスト用のサーバーです。アクセストークンがありません' });
		return;
	}

	try {
		if (req.method === 'POST') {
			if (path === '/api/join') return await handleJoin(req, res);
			if (path === '/api/say') return await handleSay(req, res);
			if (path === '/api/leave') return await handleLeave(req, res);
			// 落とす。うっかり叩かないよう /api/admin/ に分けている
			if (path === '/api/admin/exit') return await handleExit(req, res, url);
			// 片付けと戻しは GET では受けない。先読みや履歴からの再実行で起きては困る
			if (path === '/api/admin/archive') return await handleArchive(req, res);
			if (path === '/api/admin/restore') return await handleRestore(req, res);
			// 付け替えも同じ理由で GET では受けない
			if (path === '/api/admin/rename') return await handleRename(req, res);
		}
		if (req.method === 'GET') {
			if (path === '/api/poll') return await handlePoll(req, res, url);
			if (path === '/api/history') return handleHistory(res, url);
			if (path === '/api/cursor-status') return handleCursorStatus(res, url);
			if (path === '/api/dump') return handleDump(res);
			if (path === '/api/connectors') return handleConnectors(res);
			if (path === '/api/rooms') return handleRooms(res);
			if (path === '/api/version') return handleVersion(res);
			// 一覧と下見は読むだけなので GET でよい
			if (path === '/api/admin/archives') return handleArchives(res);
			if (path === '/api/admin/archive-preview') return await handleArchivePreview(req, res, url);
			if (path === '/api/admin/rename-preview') return handleRenamePreview(res, url);
			if (path === '/api/events') return handleEvents(req, res, url);
			// ブラウザのアドレスバーから叩けるよう GET も受ける
			if (path === '/api/admin/exit') return await handleExit(req, res, url);
			if (!path.startsWith('/api/')) return await serveStatic(res, path);
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
	const servers = await startListening(handleRequest, port, hosts);
	startSweeping();
	return servers;
}

/**
 * すでに待ち受けているサーバーの受け口を、通常の受け口にする。
 *
 * メンテナンス中は待ち受けだけを先に始めており、印が消えた時点でここへ来る。
 * 待ち受けを切らずに差し替えるので、ポートが空く瞬間がない。
 */
export function takeOver(servers) {
	setHandler(servers, handleRequest);
	startSweeping();
	return servers;
}

/**
 * 運用を再開したことを既定のルームに知らせる。
 *
 * 読んだ位置は保たれるので取りこぼしは無いが、**遅れたことは書かないと分からない**。
 * 止まっていた長さを添える。
 *
 * 印を待った起動のときだけ呼ぶ。素の restart（コードの入れ替え）でも流すと、
 * 開発中にルームが起動メッセージで埋まる。
 *
 * 名乗るのはこのプロジェクトのフォルダ名。本文は【メンテナンス】で始める。
 * いまは say で出しているため、セッションの発言と名前では区別できないため。
 */
export function announceResumed(since) {
	const minutes = since ? Math.max(1, Math.round((Date.now() - new Date(since).getTime()) / 60000)) : null;
	const howLong = minutes ? `約 ${minutes} 分止まっていました。` : '';
	const body = `【メンテナンス】運用を再開しました。${howLong}読んだ位置は保たれているので、取りこぼしはありません。`;

	try {
		touchConnector(SERVER_ID);
		const message = postSystemMessage(DEFAULT_ROOM, SERVER_ID, 'say', body);
		broadcastPresence();
		return message;
	} catch (err) {
		// 案内が出せなくても運用は続ける。落とす理由がない
		log.warn(`再開の案内を出せませんでした: ${err?.message ?? err}`);
		return null;
	}
}

/** オフラインへ落ちた人を定期的に見つける */
function startSweeping() {
	if (offlineTimer) return;
	offlineTimer = setInterval(sweepOffline, OFFLINE_CHECK_MS);
	offlineTimer.unref?.();
}

let offlineTimer = null;

export function stopServers(servers) {
	if (offlineTimer) {
		clearInterval(offlineTimer);
		offlineTimer = null;
	}
	releaseAll();
	return closeListening(servers);
}
