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

const ROOM = 'public';
const HISTORY_LIMIT = 50;

const el = {
	room: document.getElementById('room-name'),
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
	banner: document.getElementById('banner'),
	dialog: document.getElementById('id-dialog'),
	idInput: document.getElementById('id-input'),
};

let userId = '';
let cursor = 0;        // ここまで受け取った msg_seq
let oldestSeq = null;  // 画面に出ている中で最も古い msg_seq
let source = null;     // EventSource

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
	wrap.innerHTML =
		`<div class="meta">${escapeText(m.from_user_id)}${to} ・ ${escapeText(m.sent_at)}</div>` +
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
	}

	el.userCount.textContent = String(users.filter((u) => u.online).length);
}

// --- 通信 ---

async function api(path, init) {
	const res = await fetch(path, init);
	const json = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
	return json;
}

function showBanner(text) {
	el.banner.textContent = text;
	el.banner.hidden = false;
}

function hideBanner() {
	el.banner.hidden = true;
}

function connectEvents() {
	if (source) source.close();
	source = new EventSource(
		`/api/events?user_id=${encodeURIComponent(userId)}&room_id=${encodeURIComponent(ROOM)}&since=${cursor}`
	);

	source.addEventListener('message', (e) => appendMessages([JSON.parse(e.data)]));
	source.addEventListener('presence', (e) => renderUsers(JSON.parse(e.data)));
	source.addEventListener('open', hideBanner);
	source.addEventListener('error', () => {
		// EventSource は自動で繋ぎ直す。繋がるまでは帯を出しておく
		showBanner('接続が切れました。繋ぎ直しています…');
	});
}

async function start() {
	el.room.textContent = ROOM;
	el.me.textContent = userId;

	const joined = await api('/api/join', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ user_id: userId, user_role: 'human', room_id: ROOM }),
	});
	renderUsers(joined.users);

	const history = await api(`/api/history?room_id=${encodeURIComponent(ROOM)}&limit=${HISTORY_LIMIT}`);
	if (history.messages.length > 0) {
		oldestSeq = history.messages[0].msg_seq;
		cursor = history.messages[history.messages.length - 1].msg_seq;
		for (const m of history.messages) el.items.appendChild(messageElement(m));
		el.log.scrollTop = el.log.scrollHeight;
	} else {
		cursor = joined.msg_seq;
		el.more.hidden = true;
	}

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
				room_id: ROOM,
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
			`/api/history?room_id=${encodeURIComponent(ROOM)}&before=${oldestSeq}&limit=${HISTORY_LIMIT}`
		);
		prependMessages(past.messages);
	} finally {
		el.loadMore.disabled = false;
	}
});

el.changeId.addEventListener('click', () => askId(true));

// 画面を閉じるときに離脱を伝える。届かなくても猶予の後にオフラインになる
window.addEventListener('pagehide', () => {
	navigator.sendBeacon?.(
		'/api/leave',
		new Blob([JSON.stringify({ user_id: userId, room_id: ROOM })], { type: 'application/json' })
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
