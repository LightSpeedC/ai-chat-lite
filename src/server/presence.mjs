import { ONLINE_GRACE_MS } from './config.mjs';
import { jstBefore } from './time.mjs';
import { listUsers, getUser } from './store.mjs';

/**
 * 在席の状態は三段階。
 *
 *   online   long-poll / SSE の接続を保持中               確実にいる
 *   grace    接続は切れたが、最後のアクセスから 90 秒以内   まだいるとみなす
 *   offline  それ以降                                     いない
 *
 * 接続の有無を第一の根拠にするのは、long-poll と SSE がどちらも接続を張りっぱなしに
 * するため。サーバー側で接続数を数えるだけで確実な判定ができ、別途ハートビートを
 * 実装せずに済む。
 *
 * grace を挟むのは、AI セッションが待受けを張り直す間に一瞬途切れるため。
 * サブエージェントが終了してから親が次の待受けを立てるまでの空白が、そのまま
 * オフライン表示になるのを防ぐ。
 *
 * 状態を増やすときはここに足す（処理中・離席など）。色は状態名から UI 側で決める。
 */
export const STATUS = {
	ONLINE: 'online',
	GRACE: 'grace',
	OFFLINE: 'offline',
};

/** 画面や CLI にそのまま出せる日本語。色は持たせない（表示側の責務） */
export const STATUS_LABEL = {
	[STATUS.ONLINE]: '接続中',
	[STATUS.GRACE]: '一時切断',
	[STATUS.OFFLINE]: 'オフライン',
};

/** 一覧の並び順。オンラインに近いものを先に置く */
const STATUS_ORDER = {
	[STATUS.ONLINE]: 0,
	[STATUS.GRACE]: 1,
	[STATUS.OFFLINE]: 2,
};

/** 猶予の境界を、DB に入っているのと同じ書式の JST 文字列で返す */
export function graceThreshold() {
	return jstBefore(ONLINE_GRACE_MS);
}

/**
 * 在席の状態を返す。
 * @param user users テーブルの 1 行
 * @param threshold graceThreshold() の結果。一覧を回すときは 1 回だけ求めて渡す
 * @returns {'online'|'grace'|'offline'}
 */
export function getStatus(user, threshold = graceThreshold()) {
	if (!user) return STATUS.OFFLINE;
	if (user.active_connection_count > 0) return STATUS.ONLINE;
	// 固定長の JST 文字列同士なので、辞書順の比較がそのまま時刻の前後になる
	return user.last_active_at >= threshold ? STATUS.GRACE : STATUS.OFFLINE;
}

/**
 * 表示用に 1 人分をまとめる。
 *
 * status が本体で、online と connected はそこから導ける値。
 * 「いるかどうか」だけを見たい場面と「本当に繋がっているか」を見たい場面が
 * どちらもあるため、判定を呼び出し側で書き直さずに済むよう併せて返す。
 */
export function describeUser(user, threshold = graceThreshold()) {
	const status = getStatus(user, threshold);
	return {
		user_id: user.user_id,
		user_role: user.user_role,
		status,
		status_label: STATUS_LABEL[status],
		online: status !== STATUS.OFFLINE,
		connected: status === STATUS.ONLINE,
		active_connection_count: user.active_connection_count,
		first_joined_at: user.first_joined_at,
		last_active_at: user.last_active_at,
	};
}

/**
 * 参加者一覧。online → grace → offline の順に、その中では最後のアクセスが
 * 新しい順で並べる。画面の一覧をそのまま描ける形にしておく。
 */
export function listPresence() {
	const threshold = graceThreshold();
	return listUsers()
		.map((u) => describeUser(u, threshold))
		.sort((a, b) => {
			const diff = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
			if (diff !== 0) return diff;
			return a.last_active_at < b.last_active_at ? 1 : -1;
		});
}

/** 1 人分の状態。居なければ null */
export function getPresence(userId) {
	const user = getUser(userId);
	return user ? describeUser(user) : null;
}

/** 状態ごとの人数。「3 人が接続中」のような表示に使う */
export function countByStatus() {
	const threshold = graceThreshold();
	const counts = { [STATUS.ONLINE]: 0, [STATUS.GRACE]: 0, [STATUS.OFFLINE]: 0 };
	for (const user of listUsers()) counts[getStatus(user, threshold)]++;
	return counts;
}

/** オフラインでない人数（online と grace の合計） */
export function countOnline() {
	const counts = countByStatus();
	return counts[STATUS.ONLINE] + counts[STATUS.GRACE];
}
