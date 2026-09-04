/*
 * 古くなった参加・離脱を画面から外す判定。
 *
 * chat.js から切り離してあるのは、テストから読めるようにするため。chat.js は
 * 読み込んだ時点で document を触るので、node からは読めない（markdown.js と同じ理由）。
 */

/** 参加・離脱の行を画面に出しておく長さ。これより古いものは出さない */
export const SYSTEM_KEEP_MS = 12 * 3600 * 1000;

/** JST は UTC より 9 時間進んでいる。日本標準時に夏時間は無いので常に固定 */
const JST_OFFSET_MS = 9 * 3600 * 1000;

/**
 * 指定ミリ秒前の JST を、サーバーと同じ書式（yyyy/mm/dd hh:mm:ss.mmm）で返す。
 *
 * 文字列のまま比べられるので、Date のパース（ブラウザのタイムゾーン依存）を挟まない。
 * 固定長で辞書順と時系列順が一致するため、比較演算子がそのまま使える。
 * サーバー側の time.mjs と同じ形を作っている。
 */
export function jstBefore(ms, now = Date.now()) {
	return new Date(now + JST_OFFSET_MS - ms)
		.toISOString()
		.slice(0, 23)
		.replace('T', ' ')
		.replaceAll('-', '/');
}

/**
 * 古くなった参加・離脱かどうか。
 *
 * 対象は join と leave だけである。archive（片付けの知らせ）と notice（案内）は
 * 古くても残す。片付けの知らせには戻すボタンが付いているため、消すと戻せなくなる。
 * 発言（say）はもちろん残す。
 *
 * 判定は描画するときに 1 度だけ行う。開いたまま 12 時間が過ぎた分は消えないが、
 * そのために時計を持つほどのことではない。
 */
export function isStaleSystem(m, now = Date.now()) {
	if (m.msg_kind !== 'join' && m.msg_kind !== 'leave') return false;
	return m.sent_at < jstBefore(SYSTEM_KEEP_MS, now);
}
