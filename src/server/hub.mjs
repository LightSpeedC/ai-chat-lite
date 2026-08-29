import { getSince } from './store.mjs';

/**
 * 新着を待っている相手をまとめて管理する。
 *
 * long-poll（1 回待って返す）と SSE（繋ぎっぱなしで push する）の 2 通りがあるが、
 * 「投稿があったら知らせる」という点は同じなのでここに集める。
 *
 * この状態はプロセスで 1 つだけ持つ。待ち受けアドレスは ::1 と 127.0.0.1 の
 * 2 つあるが、待機リストを分けてしまうと、::1 で繋いだブラウザに 127.0.0.1 から
 * 投稿したメッセージが届かなくなる。
 */

/** long-poll で待っている人。{ roomId, since, settle, timer } */
const waiters = new Set();

/** SSE で繋ぎっぱなしの人。{ roomId, send(event, data) } */
const sseClients = new Set();

/**
 * 新着メッセージを待つ。すでにあれば待たずに返す。
 * 時間切れになったときは空配列を返す（着信が無かったことと区別できる）。
 *
 * @param {string} roomId
 * @param {number} since この msg_seq より新しいものを待つ
 * @param {number} timeoutMs
 * @returns {Promise<object[]>}
 */
export function waitForMessages(roomId, since, timeoutMs) {
	const existing = getSince(roomId, since);
	if (existing.length > 0) return Promise.resolve(existing);

	return new Promise((resolve) => {
		const waiter = { roomId, since };
		waiter.settle = (messages) => {
			if (!waiters.has(waiter)) return; // 二重に呼ばれても 1 回だけ
			waiters.delete(waiter);
			clearTimeout(waiter.timer);
			resolve(messages);
		};
		// unref しておくと、待機中でもプロセスの終了を妨げない
		waiter.timer = setTimeout(() => waiter.settle([]), timeoutMs);
		waiter.timer.unref?.();
		waiters.add(waiter);
	});
}

/**
 * 投稿されたメッセージを、待っている相手に配る。
 * 待っていた人は自分のカーソル以降をまとめて受け取る（取りこぼしを防ぐため、
 * 渡されたメッセージ 1 件ではなく DB から引き直す）。
 */
export function publish(message) {
	for (const waiter of [...waiters]) {
		if (waiter.roomId !== message.room_id) continue;
		if (message.msg_seq <= waiter.since) continue;
		waiter.settle(getSince(waiter.roomId, waiter.since));
	}
	for (const client of [...sseClients]) {
		if (client.roomId !== message.room_id) continue;
		client.send('message', message);
	}
}

/** 在席の変化を SSE の相手だけに伝える。メッセージのカーソルは動かさない */
export function publishPresence(presenceList) {
	for (const client of [...sseClients]) {
		client.send('presence', presenceList);
	}
}

export function addSseClient(client) {
	sseClients.add(client);
}

export function removeSseClient(client) {
	sseClients.delete(client);
}

/** 待っている人を全員起こす。サーバーを畳むときに使う */
export function releaseAll() {
	for (const waiter of [...waiters]) waiter.settle([]);
}

/** 診断用。待機の数が想定どおりかを外から確かめる */
export function stats() {
	return { waiters: waiters.size, sseClients: sseClients.size };
}
