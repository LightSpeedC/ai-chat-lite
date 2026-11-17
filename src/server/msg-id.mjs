/**
 * 発言番号 msg_id (m{yymmdd}-nn) の作り方と読み方。
 *
 * 形: m + yymmdd (sent_at の日 / JST) + - + nn。nn はその日の何件目かで、1 件目から振る。
 *
 * nn は 35 字 (数字 10 字と、l を除く小文字 25 字) の数で、先頭の z が「桁が伸びる」印になる。
 *   z が k 個 + 先頭が z 以外の (2 + k) 字 = 全体で 2 + 2k 桁
 *   k=0: 01〜yz (1,189 件) / k=1: z000〜zyzz (41,650 件) / k=2: zz0000〜 ...
 * 文字列の大小が件数の大小と同じになる (長さが混ざっても崩れない)。
 *
 * 版 8 (src/scripts/20_migrate/ver_000008) の SQL は、2 桁の部分だけを同じ式で作る。
 * 変えるときは、版を足し、tests/msg-id.test.mjs と tests/migrate-msg-id.test.mjs で突き合わせる。
 */

export const ALPHABET = '0123456789abcdefghijkmnopqrstuvwxyz';
const BASE = ALPHABET.length; // 35
const LEAD = 'z'; // 桁が伸びる印。ALPHABET の最後の字

/** 段 k が始まる件数 (k=0 は 0。0 は使わず、1 から振る) */
function tierBase(k) {
	let base = 0;
	for (let i = 0; i < k; i++) base += (BASE - 1) * BASE ** (1 + i);
	return base;
}

/** 件数 (1 以上の整数) → nn */
export function countToNn(n) {
	if (!Number.isSafeInteger(n) || n < 1) throw new RangeError(`件数は 1 以上の整数です: ${n}`);
	let k = 0;
	while (n >= tierBase(k + 1)) k++;
	let v = n - tierBase(k);
	let digits = '';
	for (let i = 0; i < 2 + k; i++) {
		digits = ALPHABET[v % BASE] + digits;
		v = Math.floor(v / BASE);
	}
	return LEAD.repeat(k) + digits;
}

/** nn → 件数。nn の形でなければ null */
export function nnToCount(nn) {
	if (typeof nn !== 'string') return null;
	let k = 0;
	while (nn[k] === LEAD) k++;
	const rest = nn.slice(k);
	if (nn.length !== 2 + 2 * k || rest.length !== 2 + k) return null;
	let v = 0;
	for (const ch of rest) {
		const d = ALPHABET.indexOf(ch);
		if (d < 0) return null;
		v = v * BASE + d;
	}
	const n = tierBase(k) + v;
	return n >= 1 ? n : null;
}

/** 'yymmdd' と件数 → 'm{yymmdd}-nn' */
export function makeMsgId(day, count) {
	return `m${day}-${countToNn(count)}`;
}

/** msg_id の形なら { day, count }、そうでなければ null */
export function parseMsgId(text) {
	if (typeof text !== 'string') return null;
	const m = /^m(\d{6})-([0-9a-km-z]{2,})$/.exec(text);
	if (!m) return null;
	const count = nnToCount(m[2]);
	return count === null ? null : { day: m[1], count };
}

/** sent_at ('yyyy/mm/dd hh:mm:ss.mmm') の日を 'yymmdd' にする */
export function dayOfSentAt(sentAt) {
	return sentAt.slice(2, 4) + sentAt.slice(5, 7) + sentAt.slice(8, 10);
}
