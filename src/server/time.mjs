/** JST は UTC より 9 時間進んでいる。日本標準時は夏時間を採用していないため常に固定 */
const JST_OFFSET_MS = 9 * 3600 * 1000;

/** Date を "2026-08-29 12:34:56.789" の形に整える */
function format(date) {
	return date
		.toISOString()      // 2026-08-29T12:34:56.789Z
		.slice(0, 23)       // 2026-08-29T12:34:56.789
		.replace('T', ' '); // 2026-08-29 12:34:56.789
}

/**
 * JST の現在時刻を "2026-08-29 12:34:56.789" 形式で返す。
 *
 * SQLite の datetime() は UTC を返すため使わない。OS のタイムゾーン設定にも
 * 依存させないよう、UTC に 9 時間足して整形する。
 * 固定長にしているのは、辞書順と時系列順を一致させるため。
 */
export function nowJst() {
	return format(new Date(Date.now() + JST_OFFSET_MS));
}

/**
 * 指定ミリ秒前の JST を、nowJst と同じ書式で返す。
 *
 * 「90 秒以内かどうか」の判定に使う。DB に入っている値と同じ固定長の文字列に
 * してから比較すれば、Date のパース（ローカルタイムゾーン依存）を挟まずに済む。
 */
export function jstBefore(ms) {
	return format(new Date(Date.now() + JST_OFFSET_MS - ms));
}
