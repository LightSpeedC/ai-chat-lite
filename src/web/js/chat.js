/*
 * ai-chat-lite ブラウザ画面
 *
 * 起動の順序:
 *   1. ID を決める（localStorage、無ければ尋ねる）
 *   2. join で参加登録し、現在位置と参加者一覧を受け取る
 *   3. history で直近 50 件を取る
 *   4. events（SSE）を繋ぐ。3 と 4 の隙間に届いた分は since で埋まる
 */

import { renderBody, escapeText } from './markdown.js';
import { isStaleSystem } from './stale.js';

const HISTORY_LIMIT = 50;

/** いま見ているルーム。切り替えたら覚えておく */
let room = localStorage.getItem('aichat.room') || 'public';

const el = {
	roomSelect: document.getElementById('room-select'),
	newRoom: document.getElementById('new-room'),
	roomDialog: document.getElementById('room-dialog'),
	roomInput: document.getElementById('room-input'),
	me: document.getElementById('me-label'),
	changeId: document.getElementById('change-id'),
	connectorList: document.getElementById('connector-list'),
	connectorCount: document.getElementById('connector-count'),
	connectorIds: document.getElementById('connector-ids'),
	items: document.getElementById('items'),
	log: document.getElementById('log'),
	more: document.getElementById('more'),
	loadMore: document.getElementById('load-more'),
	form: document.getElementById('composer'),
	input: document.getElementById('input'),
	to: document.getElementById('to'),
	replyTo: document.getElementById('reply-to'),
	send: document.getElementById('send'),
	version: document.getElementById('version'),
	banner: document.getElementById('banner'),
	dialog: document.getElementById('id-dialog'),
	idInput: document.getElementById('id-input'),
	openArchives: document.getElementById('open-archives'),
	archiveCount: document.getElementById('archive-count'),
	archivesDialog: document.getElementById('archives-dialog'),
	archivesBody: document.getElementById('archives-body'),
	restoreDialog: document.getElementById('restore-dialog'),
	restoreTarget: document.getElementById('restore-target'),
};

let connectorId = '';
let cursor = 0;        // ここまで受け取った msg_seq
let oldestSeq = null;  // 画面に出ている中で最も古い msg_seq
let source = null;     // EventSource
let serverVersion = null; // 最後に受け取ったサーバーの版

/*
 * 誰がいまどの状態かを覚えておく。発言の脇に印を出すために使う。
 *
 * 発言そのものは過去の記録だが、印は「いまの状態」を映す。発言した時点の
 * 状態は DB に持っていないため作れない。参加者一覧と食い違わない方を採る。
 */
const statusOf = new Map();

/*
 * いま戻せる片付け。archived_seq をキーにする。
 *
 * 片付けの知らせに添える「戻す」ボタンの出し入れに使う。戻したものは
 * archives から消えるため、ここからも消える。
 */
const liveArchives = new Map();

// --- 本文の描画 ---

/**
 * 返信元を 1 行で引用する。
 *
 * 画面に出ている中から探す。無ければ番号だけを出す。サーバーに問い合わせない。
 * 片付けられた発言や、まだ読み込んでいない古い発言を指すことがあるためで、
 * そこで問い合わせると 1 件ごとに往復が増える。
 */
function replyQuote(seq) {
	const parent = el.log.querySelector(`.msg[data-msg-seq="${seq}"] .body`);
	if (!parent) return `<div class="reply-to">↳ #${seq}</div>`;

	// 引用は 1 行に切る。長い本文をそのまま重ねると読みづらい
	const text = parent.textContent.replace(/\s+/g, ' ').trim();
	const short = text.length > 60 ? `${text.slice(0, 60)}…` : text;
	return `<div class="reply-to">↳ #${seq} ${escapeText(short)}</div>`;
}

/**
 * 返信先の入力を数にする。空なら null。
 *
 * 先頭の # は落とす。画面には #474 と出るので、そのまま写して貼れるようにする。
 * 数でなければ null にする（送信そのものは止めない）。
 */
function replyToValue() {
	const raw = el.replyTo.value.trim().replace(/^#/, '');
	if (!/^\d+$/.test(raw)) return null;
	const n = Number(raw);
	return n >= 1 ? n : null;
}

function messageElement(m) {
	const wrap = document.createElement('div');

	// 返信元を引くための目印。replyQuote がこれで探す
	wrap.dataset.msgSeq = String(m.msg_seq);

	if (m.msg_kind !== 'say') {
		wrap.className = 'msg system';

		/*
		 * 日時と番号は発言と同じ形で出す。番号が無いと --reply-to に渡す先が
		 * 画面から読み取れず、日時が無いといつの出来事か分からない。
		 */
		wrap.innerHTML =
			`<div class="meta">${escapeText(m.sent_at)} ・ <span class="seq">#${m.msg_seq}</span></div>` +
			`<div class="body">${renderBody(m.msg_body)}</div>`;

		/*
		 * 片付けの知らせには、その場で戻すボタンを添える。
		 *
		 * どの操作を指しているかは ref_archived_seq が持つ。本文は --description で
		 * 書き換えられるため、番号を本文から拾うことはできない。
		 *
		 * ボタンを出すかどうかは、その番号がまだ生きているかで決める。戻したあとは
		 * archives から消えるので、押せる状態で残らない。
		 */
		if (m.ref_archived_seq) {
			wrap.dataset.refArchivedSeq = String(m.ref_archived_seq);
			const button = document.createElement('button');
			button.type = 'button';
			button.className = 'restore-here';
			button.textContent = '戻す';
			button.hidden = !liveArchives.has(m.ref_archived_seq);
			button.addEventListener('click', () => {
				const a = liveArchives.get(m.ref_archived_seq);
				if (a) confirmRestore(a);
			});
			wrap.appendChild(button);
		}
		return wrap;
	}

	const mine = m.from_connector_id === connectorId;
	const toMe = m.to_connector_id === connectorId;
	wrap.className = 'msg' + (mine ? ' mine' : '') + (toMe ? ' to-me' : '');

	const to = m.to_connector_id ? ` <span class="to">@${escapeText(m.to_connector_id)}</span>` : '';

	// 参加者一覧と同じ印を出す。data-connector は presence が届いたとき塗り直すための目印
	const status = statusOf.get(m.from_connector_id) ?? 'offline';
	const mark = `<span class="mark ${status}" data-connector="${escapeText(m.from_connector_id)}"></span>`;

	/*
	 * 返信元を 1 行だけ引用する。
	 *
	 * 指す先が画面に無いことがある（片付けられた、まだ読み込んでいない）。
	 * サーバーに問い合わせず、持っている範囲だけで出す。無ければ番号だけ出す。
	 * 存在を強いると、返信が付いた発言を片付けられなくなるため。
	 */
	const reply = m.reply_to_msg_seq ? replyQuote(m.reply_to_msg_seq) : '';

	wrap.innerHTML =
		`<div class="meta">${mark}<span class="who">${escapeText(m.from_connector_id)}</span>${to}` +
		` ・ ${escapeText(m.sent_at)} ・ <span class="seq">#${m.msg_seq}</span></div>` +
		reply +
		`<div class="body">${renderBody(m.msg_body)}</div>`;
	return wrap;
}

// --- メッセージの追加 ---

function isAtBottom() {
	return el.log.scrollHeight - el.log.scrollTop - el.log.clientHeight < 80;
}

function appendMessages(messages) {
	if (messages.length === 0) return;
	const stick = isAtBottom();
	for (const m of messages) {
		if (m.msg_seq <= cursor) continue;
		// 出さない分も cursor は進める。止めると同じ行を何度も取りに行く
		if (!isStaleSystem(m)) el.items.appendChild(messageElement(m));
		cursor = m.msg_seq;
		if (oldestSeq === null) oldestSeq = m.msg_seq;
	}
	if (stick) el.log.scrollTop = el.log.scrollHeight;
}

function prependMessages(messages) {
	if (messages.length === 0) {
		el.more.hidden = true;
		return;
	}
	const before = el.log.scrollHeight;
	for (let i = messages.length - 1; i >= 0; i--) {
		// 出さない分も oldestSeq は進める。止めると「もっと読む」が同じ所を繰り返す
		if (!isStaleSystem(messages[i])) {
			el.items.insertBefore(messageElement(messages[i]), el.items.firstChild);
		}
		oldestSeq = messages[i].msg_seq;
	}
	// 読み込み前に見ていた位置を保つ
	el.log.scrollTop += el.log.scrollHeight - before;
}

// --- 参加者 ---

function renderConnectors(connectors) {
	el.connectorList.textContent = '';
	el.connectorIds.textContent = '';

	for (const u of connectors) {
		const li = document.createElement('li');
		li.className = u.status;
		li.title = `${u.status_label} ・ 最終 ${u.last_active_at}`;
		li.innerHTML =
			`<span class="mark ${u.status}"></span>` +
			`<span class="name">${escapeText(u.connector_id)}</span>` +
			`<span class="role">${escapeText(u.connector_role)}</span>`;
		el.connectorList.appendChild(li);

		const option = document.createElement('option');
		option.value = u.connector_id;
		el.connectorIds.appendChild(option);

		statusOf.set(u.connector_id, u.status);
	}

	el.connectorCount.textContent = String(connectors.filter((u) => u.online).length);
	refreshMessageMarks();
}

/*
 * 既に出ている発言の印を、いまの状態に合わせ直す。
 *
 * 在席は変わり続けるため、描いたときのままにすると参加者一覧と食い違う。
 * presence が届くたびに塗り直す。
 */
function refreshMessageMarks() {
	for (const mark of el.log.querySelectorAll('.msg .mark[data-connector]')) {
		const status = statusOf.get(mark.dataset.connector) ?? 'offline';
		mark.className = `mark ${status}`;
	}
}

// --- 通信 ---

/*
 * テスト用のサーバーへ繋ぐためのアクセストークン。
 *
 * テスト環境はアクセストークンを持たない相手を断る。他プロジェクトがポートを見つけて
 * 繋いでも、テスト中のデータに混ざらないようにするため。
 *
 *   http://localhost:8765/?access_token=xxxx
 *
 * URL から受け取り、そのタブで覚えておく。2 回目以降はクエリが要らない。
 * 起動するたびに値が変わるので、タブを閉じたら消える sessionStorage に置く。
 * 本番では渡されないので空になり、何も付かない。
 */
const ACCESS_TOKEN = (() => {
	const fromUrl = new URLSearchParams(location.search).get('access_token');
	try {
		if (fromUrl) {
			sessionStorage.setItem('aichat.access_token', fromUrl);
			return fromUrl;
		}
		return sessionStorage.getItem('aichat.access_token') ?? '';
	} catch {
		// プライベートウィンドウなどで使えないことがある。URL の分だけで動かす
		return fromUrl ?? '';
	}
})();

/** アクセストークンがあればクエリに足す。SSE（EventSource）はヘッダを付けられないため */
function withAccessToken(path) {
	if (!ACCESS_TOKEN) return path;
	return path + (path.includes('?') ? '&' : '?') + 'access_token=' + encodeURIComponent(ACCESS_TOKEN);
}

async function api(path, init) {
	const headers = { ...(init?.headers ?? {}) };
	if (ACCESS_TOKEN) headers['X-AiChat-Access-Token'] = ACCESS_TOKEN;

	const res = await fetch(path, { ...init, headers });
	const json = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
	return json;
}

/*
 * どちらの環境に繋いでいるかを見た目に出す。
 *
 * 本番とテストで画面が同じだと、人が取り違える。色を変え、名札も出す。
 * 色だけに頼らないのは、見分けがつきにくい場合や白黒で印刷した場合のため。
 */
function applyEnv(env) {
	if (!env) return;
	document.body.dataset.env = env;

	const badge = document.getElementById('env-badge');
	if (badge) badge.hidden = env !== 'test';
}

/**
 * メンテナンス中であることを出す。
 *
 * 環境の色（本番＝紺／テスト＝赤茶）とは別の軸なので、色を置き換えずに帯で重ねる。
 * 入力欄は使えないようにする。書けても届かないため。
 */
function applyMaintenance(maintenance, since, reason) {
	document.body.dataset.maintenance = maintenance ? 'yes' : '';

	const input = document.getElementById('input');
	const send = document.getElementById('send');
	if (input) input.disabled = Boolean(maintenance);
	if (send) send.disabled = Boolean(maintenance);

	if (!maintenance) return;
	const from = since ? `（${new Date(since).toLocaleString('ja-JP')} から）` : '';
	const why = reason ? ` ${reason}` : '';
	showBanner(`メンテナンス中です${from}。${why} 再開までお待ちください。`);
}

function showBanner(text) {
	el.banner.textContent = text;
	el.banner.hidden = false;
}

function hideBanner() {
	el.banner.hidden = true;
}

/**
 * サーバーの版を確かめる。
 *
 * サーバーは起動するたびに版が変わる。SSE は切れると自動で繋ぎ直すため、
 * 入れ替えのあとは新しい版がここへ届く。前と違っていれば画面も古いので読み直す。
 */
function checkVersion({ version, env, maintenance, maintenance_since, maintenance_reason }) {
	el.version.textContent = version;
	applyEnv(env);
	applyMaintenance(maintenance, maintenance_since, maintenance_reason);

	if (serverVersion === null) {
		serverVersion = version;
		return;
	}
	if (serverVersion === version) return;

	showBanner(`サーバーが新しくなりました（${version}）。読み直します…`);
	// 帯を読める間だけ待ってから読み直す
	setTimeout(() => location.reload(), 1500);
}

function connectEvents() {
	if (source) source.close();
	source = new EventSource(
		withAccessToken(`/api/events?connector_id=${encodeURIComponent(connectorId)}&room_id=${encodeURIComponent(room)}&since=${cursor}`)
	);

	source.addEventListener('message', (e) => {
		const m = JSON.parse(e.data);
		appendMessages([m]);
		// 誰かが片付けたら件数が変わる。ボタンの出し入れもここで追随する
		if (m.msg_kind === 'archive') refreshArchives();
	});
	source.addEventListener('presence', (e) => renderConnectors(JSON.parse(e.data)));
	source.addEventListener('version', (e) => checkVersion(JSON.parse(e.data)));

	/*
	 * 切れている間に届いた分が多すぎて、サーバーが途中で流すのをやめた。
	 *
	 * このまま続けると、欠けたところを飛ばして新しい分だけが並ぶ。
	 * 読み飛ばしと区別がつかないので、読み直す。
	 */
	source.addEventListener('truncated', () => {
		showBanner('切れている間の発言が多いため、読み直します…');
		setTimeout(() => location.reload(), 1500);
	});
	source.addEventListener('open', hideBanner);
	source.addEventListener('error', () => {
		// EventSource は自動で繋ぎ直す。繋がるまでは帯を出しておく
		showBanner('接続が切れました。繋ぎ直しています…');
	});
}

/** ルームの一覧を読み直して、選択欄に並べる */
async function loadRooms() {
	const { rooms } = await api('/api/rooms');
	el.roomSelect.textContent = '';

	for (const r of rooms) {
		const option = document.createElement('option');
		option.value = r.room_id;
		option.textContent = r.msg_count > 0 ? `${r.room_id} (${r.msg_count})` : r.room_id;
		el.roomSelect.appendChild(option);
	}

	// まだ発言が無いルームは一覧に現れないため、選んでいる分を足しておく
	if (![...el.roomSelect.options].some((o) => o.value === room)) {
		const option = document.createElement('option');
		option.value = room;
		option.textContent = room;
		el.roomSelect.appendChild(option);
	}
	el.roomSelect.value = room;
}

/**
 * ルームを切り替える。表示を空にしてから読み直す。
 *
 * force は同じルームのまま読み直したいとき用。戻したものは SSE で流れて
 * こない（既にある行の archived_seq を NULL にするだけで、新しい発言が
 * 積まれるわけではない）ため、取り込むには読み直すしかない。
 */
async function switchRoom(next, force = false) {
	if (!next || (next === room && !force)) return;
	room = next;
	localStorage.setItem('aichat.room', room);

	el.items.textContent = '';
	cursor = 0;
	oldestSeq = null;
	el.more.hidden = false;
	await start();
}

/*
 * メンテナンス中かどうかを尋ねる。
 *
 * 印がある間、API は 503 を返すが /api/version だけは 200 で状態を返す
 * （src/server/maintenance-handler.mjs）。SSE も 503 なので、帯を出せるのは
 * この口だけである。ここを叩いていなかったため、印があるときの画面は
 * 版が「—」・参加者 0 人・ログ空・入力欄は使えるまま、という姿だった。
 *
 * @returns {Promise<boolean>} メンテナンス中か
 */
async function checkMaintenance() {
	try {
		const res = await fetch(withAccessToken('/api/version'));
		if (!res.ok) return false;
		const info = await res.json();
		el.version.textContent = info.version;
		applyEnv(info.env);
		applyMaintenance(info.maintenance, info.maintenance_since, info.maintenance_reason);
		return Boolean(info.maintenance);
	} catch {
		// 繋がらないのは別の帯が出す。ここでは判定しない
		return false;
	}
}

/** 明けるまで見に行く。明けたら読み直す */
function waitUntilCleared() {
	const timer = setInterval(async () => {
		if (await checkMaintenance()) return;
		clearInterval(timer);
		showBanner('メンテナンスが明けました。読み直します…');
		setTimeout(() => location.reload(), 1000);
	}, 5000);
}

async function start() {
	el.me.textContent = connectorId;

	/*
	 * 先に印を見る。メンテナンス中に join や history を投げると 503 になり、
	 * 例外の帯（繋がりません）が出て、本当の理由が伝わらない
	 */
	if (await checkMaintenance()) {
		waitUntilCleared();
		return;
	}

	const joined = await api('/api/join', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ connector_id: connectorId, connector_role: 'human', room_id: room }),
	});
	renderConnectors(joined.connectors);

	const history = await api(`/api/history?room_id=${encodeURIComponent(room)}&limit=${HISTORY_LIMIT}`);
	if (history.messages.length > 0) {
		oldestSeq = history.messages[0].msg_seq;
		cursor = history.messages[history.messages.length - 1].msg_seq;
		for (const m of history.messages) {
			if (!isStaleSystem(m)) el.items.appendChild(messageElement(m));
		}
		el.log.scrollTop = el.log.scrollHeight;
	} else {
		cursor = joined.msg_seq;
		el.more.hidden = true;
	}

	await loadRooms();
	await refreshArchives();
	connectEvents();
}

// --- 操作 ---

el.form.addEventListener('submit', async (e) => {
	e.preventDefault();
	const body = el.input.value.trim();
	if (!body) return;

	el.send.disabled = true;
	try {
		await api('/api/say', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				from_connector_id: connectorId,
				room_id: room,
				to_connector_id: el.to.value.trim() || null,
				reply_to_msg_seq: replyToValue(),
				msg_body: body,
			}),
		});
		el.input.value = '';
		el.replyTo.value = '';
	} catch (err) {
		showBanner(`送信できません: ${err.message}`);
		setTimeout(hideBanner, 4000);
	} finally {
		el.send.disabled = false;
		el.input.focus();
	}
});

el.input.addEventListener('keydown', (e) => {
	if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
		e.preventDefault();
		el.form.requestSubmit();
	}
});

el.loadMore.addEventListener('click', async () => {
	if (oldestSeq === null) return;
	el.loadMore.disabled = true;
	try {
		const past = await api(
			`/api/history?room_id=${encodeURIComponent(room)}&before=${oldestSeq}&limit=${HISTORY_LIMIT}`
		);
		prependMessages(past.messages);
	} finally {
		el.loadMore.disabled = false;
	}
});

el.changeId.addEventListener('click', () => askId(true));

el.roomSelect.addEventListener('change', () => switchRoom(el.roomSelect.value));

el.newRoom.addEventListener('click', () => {
	el.roomInput.value = '';
	el.roomDialog.showModal();
});

el.roomDialog.addEventListener('close', () => {
	if (el.roomDialog.returnValue !== 'ok') return;
	const name = el.roomInput.value.trim();
	if (name) switchRoom(name);
});

/*
 * 画面を閉じるときに離脱を伝える。届かなくても猶予の後にオフラインになる。
 *
 * sendBeacon はヘッダを付けられないため、アクセストークンはクエリに載せる。
 * 付け忘れるとテスト環境では 403 で弾かれ、離脱が積まれない。
 */
window.addEventListener('pagehide', () => {
	navigator.sendBeacon?.(
		withAccessToken('/api/leave'),
		new Blob([JSON.stringify({ connector_id: connectorId, room_id: room })], { type: 'application/json' })
	);
});

// --- 片付けたもの ---

/**
 * 片付けたものを数えて、ボタンの出し入れを決める。
 *
 * 1 件も無ければボタンごと隠す。片付けは滅多に起きないので、普段は目に
 * 入らない方がよい。件数はバッジで出し、あることに気づけるようにする。
 */
async function refreshArchives() {
	let archives = [];
	try {
		({ archives } = await api('/api/admin/archives'));
	} catch {
		// 取れなくても画面は使える。黙って隠す
		el.openArchives.hidden = true;
		return [];
	}

	el.archiveCount.textContent = String(archives.length);
	el.openArchives.hidden = archives.length === 0;

	liveArchives.clear();
	for (const a of archives) liveArchives.set(a.archived_seq, a);
	refreshRestoreButtons();

	return archives;
}

/**
 * 片付けの知らせに添えたボタンを見直す。
 *
 * 誰かが戻せば、その知らせのボタンは押せなくなる。逆に読み込み直しても
 * 生きているものにはボタンが戻る。参加者の印を塗り直すのと同じ考え方。
 */
function refreshRestoreButtons() {
	for (const wrap of el.log.querySelectorAll('.msg.system[data-ref-archived-seq]')) {
		const seq = Number(wrap.dataset.refArchivedSeq);
		const button = wrap.querySelector('button.restore-here');
		if (button) button.hidden = !liveArchives.has(seq);
	}
}

/** 対象を「ルーム sandbox-a」の形にする */
function archiveTarget(a) {
	const label = { message: '発言', connector: '参加者', room: 'ルーム' }[a.archive_kind] ?? a.archive_kind;
	return `${label} ${a.archive_id}`;
}

/** 一覧を組み立てて開く */
async function openArchives() {
	const archives = await refreshArchives();
	el.archivesBody.textContent = '';

	for (const a of archives) {
		const count = Number(a.msg_count) + Number(a.cursor_count) + Number(a.connector_count);
		const tr = document.createElement('tr');

		// 本文は他人が書いた文字列。textContent で入れる（innerHTML にしない）
		for (const [text, cls] of [
			[String(a.archived_seq), 'nowrap'],
			[a.archived_at.slice(0, 16), 'nowrap'],
			[archiveTarget(a), 'nowrap'],
			[String(count), 'nowrap num'],
			[a.description, ''],
		]) {
			const td = document.createElement('td');
			td.className = cls;
			td.textContent = text;
			tr.appendChild(td);
		}

		const td = document.createElement('td');
		td.className = 'nowrap';
		const button = document.createElement('button');
		button.type = 'button';
		button.textContent = '戻す';
		button.addEventListener('click', () => confirmRestore(a));
		td.appendChild(button);
		tr.appendChild(td);

		el.archivesBody.appendChild(tr);
	}

	el.archivesDialog.showModal();
}

/**
 * 戻す前に一度だけ確かめる。
 *
 * 戻すのは元に戻すだけで失われるものが無いため、CLI のように名前を打たせる
 * ところまではしない。ただし押し間違いは起こるので 1 段は挟む。
 */
function confirmRestore(a) {
	el.restoreTarget.textContent = `archived_seq ${a.archived_seq}　${archiveTarget(a)}　${a.description}`;

	el.restoreDialog.returnValue = '';
	el.restoreDialog.showModal();

	el.restoreDialog.addEventListener(
		'close',
		async () => {
			if (el.restoreDialog.returnValue !== 'ok') return;

			try {
				await api('/api/admin/restore', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ archived_seq: a.archived_seq, connector_id: connectorId }),
				});
			} catch (err) {
				showBanner(`戻せませんでした: ${err.message}`);
				return;
			}

			/*
			 * 戻した分は SSE では流れてこない。既にある行の archived_seq を
			 * NULL に戻すだけで、新しい発言が積まれるわけではないため。
			 * 画面を読み直して取り込む。
			 */
			el.archivesDialog.close();
			await switchRoom(room === 'public' ? 'public' : room, true);
			await refreshArchives();
		},
		{ once: true }
	);
}

el.openArchives.addEventListener('click', openArchives);

// --- ID の決定 ---

function askId(force) {
	const saved = localStorage.getItem('aichat.connector_id');
	if (saved && !force) {
		connectorId = saved;
		start();
		return;
	}
	el.idInput.value = saved || '';
	el.dialog.showModal();
}

el.dialog.addEventListener('close', () => {
	const value = el.idInput.value.trim();
	if (!value) {
		el.dialog.showModal();
		return;
	}
	localStorage.setItem('aichat.connector_id', value);
	const first = connectorId === '';
	connectorId = value;
	el.me.textContent = connectorId;
	if (first) {
		start();
	} else {
		// ID を変えたら参加登録からやり直す
		el.items.textContent = '';
		cursor = 0;
		oldestSeq = null;
		start();
	}
});

askId(false);
