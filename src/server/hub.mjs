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

/** long-poll で待っている人。{ roomId, since, exclude, settle, timer } */
const waiters = new Set();

/** 何も除かないときの空集合。待つ相手ごとに作らずに済ませる */
const NOTHING = new Set();

/**
 * 除く種別を落とした残りと、走査した最後の msg_seq を返す。
 *
 * scannedSeq は除いた分も含めた位置である。呼ぶ側はここまで読んだものとして
 * 記録する。進めないと、次の待受けが同じ記録を読み直して同じ所で待つ。
 */
function sift(roomId, since, exclude) {
	const all = getSince(roomId, since);
	const scannedSeq = all.length > 0 ? all[all.length - 1].msg_seq : since;
	const messages = exclude.size === 0 ? all : all.filter((m) => !exclude.has(m.msg_kind));
	return { messages, scannedSeq };
}

/** SSE で繋ぎっぱなしの人。{ roomId, send(event, data) } */
const sseClients = new Set();

/**
 * 新着メッセージを待つ。すでにあれば待たずに返す。
 * 時間切れになったときは空配列を返す（着信が無かったことと区別できる）。
 *
 * exclude に入れた msg_kind では起こさない。除いた分でも scannedSeq は進むので、
 * 呼ぶ側はそこまで読んだものとして記録できる。進めないと、次の待受けが同じ記録を
 * 読み直して同じ所で待つことになる。
 *
 * @param {string} roomId
 * @param {number} since この msg_seq より新しいものを待つ
 * @param {number} timeoutMs
 * @param {Set<string>} [exclude] 起こさない msg_kind
 * @returns {Promise<{messages: object[], scannedSeq: number}>}
 */
export function waitForMessages(roomId, since, timeoutMs, exclude = NOTHING) {
	const first = sift(roomId, since, exclude);
	if (first.messages.length > 0) return Promise.resolve(first);

	return new Promise((resolve) => {
		// 除く分だけが積まれていたら、待つ位置をそこまで進めてから待つ
		const waiter = { roomId, since: first.scannedSeq, exclude };
		waiter.settle = (result) => {
			if (!waiters.has(waiter)) return; // 二重に呼ばれても 1 回だけ
			waiters.delete(waiter);
			clearTimeout(waiter.timer);
			resolve(result);
		};
		// unref しておくと、待機中でもプロセスの終了を妨げない
		// 時間切れでも since を返す。除く分で進んだ位置を呼ぶ側が記録できる
		waiter.timer = setTimeout(() => waiter.settle({ messages: [], scannedSeq: waiter.since }), timeoutMs);
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

		const result = sift(waiter.roomId, waiter.since, waiter.exclude);
		if (result.messages.length === 0) {
			// 除く種別だけだった。起こさず、位置だけ進めて待ち続ける
			waiter.since = result.scannedSeq;
			continue;
		}
		waiter.settle(result);
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
	for (const waiter of [...waiters]) waiter.settle({ messages: [], scannedSeq: waiter.since });
}

/** 診断用。待機の数が想定どおりかを外から確かめる */
export function stats() {
	return { waiters: waiters.size, sseClients: sseClients.size };
}
