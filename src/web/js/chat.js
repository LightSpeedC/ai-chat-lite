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
	userList: document.getElementById('user-list'),
	userCount: document.getElementById('user-count'),
	userIds: document.getElementById('user-ids'),
	items: document.getElementById('items'),
	log: document.getElementById('log'),
	more: document.getElementById('more'),
	loadMore: document.getElementById('load-more'),
	form: document.getElementById('composer'),
	input: document.getElementById('input'),
	to: document.getElementById('to'),
	send: document.getElementById('send'),
	version: document.getElementById('version'),
	banner: document.getElementById('banner'),
	dialog: document.getElementById('id-dialog'),
	idInput: document.getElementById('id-input'),
};

let userId = '';
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

// --- 本文の描画 ---

function messageElement(m) {
	const wrap = document.createElement('div');

	if (m.msg_kind !== 'say') {
		wrap.className = 'msg system';
		wrap.innerHTML = `<div class="body">${renderBody(m.msg_body)}</div>`;
		return wrap;
	}

	const mine = m.from_user_id === userId;
	const toMe = m.to_user_id === userId;
	wrap.className = 'msg' + (mine ? ' mine' : '') + (toMe ? ' to-me' : '');

	const to = m.to_user_id ? ` <span class="to">@${escapeText(m.to_user_id)}</span>` : '';

	// 参加者一覧と同じ印を出す。data-user は presence が届いたとき塗り直すための目印
	const status = statusOf.get(m.from_user_id) ?? 'offline';
	const mark = `<span class="mark ${status}" data-user="${escapeText(m.from_user_id)}"></span>`;

	wrap.innerHTML =
		`<div class="meta">${mark}<span class="who">${escapeText(m.from_user_id)}</span>${to}` +
		` ・ ${escapeText(m.sent_at)}</div>` +
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
		el.items.appendChild(messageElement(m));
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
		el.items.insertBefore(messageElement(messages[i]), el.items.firstChild);
		oldestSeq = messages[i].msg_seq;
	}
	// 読み込み前に見ていた位置を保つ
	el.log.scrollTop += el.log.scrollHeight - before;
}

// --- 参加者 ---

function renderUsers(users) {
	el.userList.textContent = '';
	el.userIds.textContent = '';

	for (const u of users) {
		const li = document.createElement('li');
		li.className = u.status;
		li.title = `${u.status_label} ・ 最終 ${u.last_active_at}`;
		li.innerHTML =
			`<span class="mark ${u.status}"></span>` +
			`<span class="name">${escapeText(u.user_id)}</span>` +
			`<span class="role">${escapeText(u.user_role)}</span>`;
		el.userList.appendChild(li);

		const option = document.createElement('option');
		option.value = u.user_id;
		el.userIds.appendChild(option);

		statusOf.set(u.user_id, u.status);
	}

	el.userCount.textContent = String(users.filter((u) => u.online).length);
	refreshMessageMarks();
}

/*
 * 既に出ている発言の印を、いまの状態に合わせ直す。
 *
 * 在席は変わり続けるため、描いたときのままにすると参加者一覧と食い違う。
 * presence が届くたびに塗り直す。
 */
function refreshMessageMarks() {
	for (const mark of el.log.querySelectorAll('.msg .mark[data-user]')) {
		const status = statusOf.get(mark.dataset.user) ?? 'offline';
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
		withAccessToken(`/api/events?user_id=${encodeURIComponent(userId)}&room_id=${encodeURIComponent(room)}&since=${cursor}`)
	);

	source.addEventListener('message', (e) => appendMessages([JSON.parse(e.data)]));
	source.addEventListener('presence', (e) => renderUsers(JSON.parse(e.data)));
	source.addEventListener('version', (e) => checkVersion(JSON.parse(e.data)));
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

/** ルームを切り替える。表示を空にしてから読み直す */
async function switchRoom(next) {
	if (!next || next === room) return;
	room = next;
	localStorage.setItem('aichat.room', room);

	el.items.textContent = '';
	cursor = 0;
	oldestSeq = null;
	el.more.hidden = false;
	await start();
}

async function start() {
	el.me.textContent = userId;

	const joined = await api('/api/join', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ user_id: userId, user_role: 'human', room_id: room }),
	});
	renderUsers(joined.users);

	const history = await api(`/api/history?room_id=${encodeURIComponent(room)}&limit=${HISTORY_LIMIT}`);
	if (history.messages.length > 0) {
		oldestSeq = history.messages[0].msg_seq;
		cursor = history.messages[history.messages.length - 1].msg_seq;
		for (const m of history.messages) el.items.appendChild(messageElement(m));
		el.log.scrollTop = el.log.scrollHeight;
	} else {
		cursor = joined.msg_seq;
		el.more.hidden = true;
	}

	await loadRooms();
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
				from_user_id: userId,
				room_id: room,
				to_user_id: el.to.value.trim() || null,
				msg_body: body,
			}),
		});
		el.input.value = '';
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
		new Blob([JSON.stringify({ user_id: userId, room_id: room })], { type: 'application/json' })
	);
});

// --- ID の決定 ---

function askId(force) {
	const saved = localStorage.getItem('aichat.user_id');
	if (saved && !force) {
		userId = saved;
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
	localStorage.setItem('aichat.user_id', value);
	const first = userId === '';
	userId = value;
	el.me.textContent = userId;
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
