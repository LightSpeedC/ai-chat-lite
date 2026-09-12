/**
 * recent --since / --before の絶対日時を解決する。
 *
 * chat.mjs から分けてあるのは、テストが日付計算だけを純粋関数として
 * 読めるようにするため（waiters-pick.mjs と同じ理由）。
 *
 * 【--since と --before は同じ規則を共有する】
 * 分けると、組み合わせたときに片方だけ丸まって範囲が壊れる。
 * 「--since 11/1 --before 11/30」を、丸めるのが --since だけだとすると、
 * 11/1 は今年が未来なので去年に丸まり、11/30 は丸めないので今年のまま
 * ——去年 11 月から今年 11 月末までという、意図しない範囲になる。
 * ここは分岐せず、1 つの関数だけを --since にも --before にも使う。
 *
 * 【--before は --since の年・日付を引き継ぐ】
 * 「未来なら 1 つ遡る」を --before にも単純に当てはめると、別の壊れ方をする。
 * 「--since 9/9 --before 9/10」（今日と明日）は、9/9 は今日なので未来ではなく
 * 今年のまま、9/10 は独立に見れば明日で未来なので去年に遡る——今日と去年の
 * 組み合わせという、これも意図しない範囲になる。
 *
 * --before に anchorTs（--since 側が解決した値）を渡すと、年・日付を省いた分は
 * 「いま」と比べて丸めるのではなく、anchorTs の年・日付をそのまま引き継ぐ。
 * これなら「今日〜明日」も「去年 11/1〜去年 11/30」も、どちらも筋の通った
 * 範囲になる（詳しくは tests/since-parse.test.mjs）。
 *
 * 【書式は 3 段】上から順に試し、最初に形が合ったものを使う。
 *   ① yyyy/m/d[<区切り>H:m[:s]]  年月日（＋任意で時刻）。省いていない
 *   ② m/d[<区切り>H:m[:s]]       月日（年を省く）
 *   ③ H:m[:s]                    時刻のみ（日付を省く）
 * 区切りは半角スペース・ハイフン・下線のどれでもよい。
 * ハイフン・下線ならコマンドラインでダブルクォートが要らない。
 *
 * ②③で省いた分は、anchorTs が無ければ「いま」と比べて未来なら 1 つ遡り
 * （②は年、③は日）、anchorTs があればその年・日付をそのまま使う（遡らない）。
 *
 * 【「いま」との比較は文字列で行う】
 * nowJst() と同じ書式（yyyy/mm/dd HH:MM:SS.mmm）は固定長で、辞書順が
 * そのまま時系列順になる。Date のミリ秒に直して比べるより、この文字列の
 * ままの比較のほうが素直（sent_at 自体もこの形で持っている）。
 */
import { nowJst, jstFromParts, shiftJst } from '../server/time.mjs';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** 日付と時刻の区切り。半角スペース・ハイフン・下線のどれでもよい */
const SEP = '[ \\-_]';

const RE_FULL = new RegExp(`^(\\d{4})/(\\d{1,2})/(\\d{1,2})(?:${SEP}(\\d{1,2}):(\\d{1,2})(?::(\\d{1,2}))?)?$`);
const RE_MONTH_DAY = new RegExp(`^(\\d{1,2})/(\\d{1,2})(?:${SEP}(\\d{1,2}):(\\d{1,2})(?::(\\d{1,2}))?)?$`);
const RE_TIME_ONLY = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/;

/** 読み手・使い方の両方に出す、書式の説明 */
export const SINCE_FORMAT_HELP =
	'日時は yyyy/m/d ・ m/d ・ H:m の 3 段のどれかです（時刻は任意で追加。区切りは半角スペース・ハイフン・下線）';

function checkRange(name, value, min, max) {
	if (value < min || value > max) {
		throw new Error(`${name}は ${min}〜${max} の範囲にしてください: ${value}`);
	}
}

/** JST の文字列（nowJst / anchorTs と同じ書式）から年月日だけを取り出す */
function dateParts(jstStr) {
	const [datePart] = jstStr.split(' ');
	const [year, month, day] = datePart.split('/').map(Number);
	return { year, month, day };
}

/**
 * その年・その月の最終日。
 *
 * Date.UTC は月を 0 起点で取るので、1 起点の month をそのまま渡すと
 * 「翌月の 0 日」＝「その月の最終日」になる。閏年もここで吸収される。
 */
function daysInMonth(year, month) {
	return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * その月に無い日を断る。
 *
 * 日の検査は 1〜31 までしか見ていない（月ごとの日数は計画書のとおり
 * 見ない仕様）。ここを素通りさせると Date が翌月へ繰り上げるため、
 * 打った日付とは別の範囲を静かに返すことになる。
 *
 * 2 月は年で日数が変わるので、年が決まってから呼ぶこと。
 */
function checkDayOfMonth(year, month, day) {
	const last = daysInMonth(year, month);
	if (day > last) {
		throw new Error(`${month} 月は ${last} 日までです（${year} 年）: ${month}/${day}`);
	}
}

/**
 * ② 月日（年を省く）を決める。
 *
 * anchorTs があれば、その年をそのまま使う（丸めない）。
 * 無ければ「いま」の年を使い、組み立てた結果が未来なら 1 年遡る。
 *
 * 日数の検査は年が決まってから行う。2/29 は年によって有無が変わるため。
 */
function resolveMonthDay({ month, day, hour, minute, second }, anchorTs) {
	if (anchorTs) {
		const { year } = dateParts(anchorTs);
		checkDayOfMonth(year, month, day);
		return jstFromParts(year, month, day, hour, minute, second);
	}

	const now = nowJst();
	const { year } = dateParts(now);
	checkDayOfMonth(year, month, day);
	const candidate = jstFromParts(year, month, day, hour, minute, second);
	if (candidate <= now) return candidate;
	checkDayOfMonth(year - 1, month, day);
	return jstFromParts(year - 1, month, day, hour, minute, second);
}

/**
 * ③ 時刻のみ（日付を省く）を決める。
 *
 * anchorTs があれば、その年月日をそのまま使う（丸めない）。
 * 無ければ「今日」を使い、組み立てた結果が未来なら 1 日遡る。
 */
function resolveTimeOnly({ hour, minute, second }, anchorTs) {
	if (anchorTs) {
		const { year, month, day } = dateParts(anchorTs);
		return jstFromParts(year, month, day, hour, minute, second);
	}

	const now = nowJst();
	const { year, month, day } = dateParts(now);
	const candidate = jstFromParts(year, month, day, hour, minute, second);
	if (candidate <= now) return candidate;
	// 月・年をまたぐ計算は shiftJst（内部は Date の引き算）に任せる
	return shiftJst(candidate, -ONE_DAY_MS);
}

/**
 * --since / --before の値を解決し、sent_at と同じ書式
 * （yyyy/mm/dd HH:MM:SS.mmm）の文字列にして返す。
 *
 * 形が合わない・範囲外なら Error を投げる（呼び出し側が CLI のエラー表示に変える）。
 *
 * @param {string} raw 渡された値
 * @param {string|null} anchorTs --before のとき、--since 側が解決した値。
 *   --since 自身を解決するときは渡さない（null のまま）
 */
export function resolveDateTimeArg(raw, anchorTs = null) {
	let m = RE_FULL.exec(raw);
	if (m) {
		const [, y, mo, d, h = '0', mi = '0', s = '0'] = m;
		const parts = { year: Number(y), month: Number(mo), day: Number(d), hour: Number(h), minute: Number(mi), second: Number(s) };
		checkRange('月', parts.month, 1, 12);
		checkRange('日', parts.day, 1, 31);
		checkRange('時', parts.hour, 0, 23);
		checkRange('分', parts.minute, 0, 59);
		checkRange('秒', parts.second, 0, 59);
		checkDayOfMonth(parts.year, parts.month, parts.day);
		// 年月日をすべて指定しているので、丸めない（anchorTs も見ない）
		return jstFromParts(parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second);
	}

	m = RE_MONTH_DAY.exec(raw);
	if (m) {
		const [, mo, d, h = '0', mi = '0', s = '0'] = m;
		const parts = { month: Number(mo), day: Number(d), hour: Number(h), minute: Number(mi), second: Number(s) };
		checkRange('月', parts.month, 1, 12);
		checkRange('日', parts.day, 1, 31);
		checkRange('時', parts.hour, 0, 23);
		checkRange('分', parts.minute, 0, 59);
		checkRange('秒', parts.second, 0, 59);
		return resolveMonthDay(parts, anchorTs);
	}

	m = RE_TIME_ONLY.exec(raw);
	if (m) {
		const [, h, mi, s = '0'] = m;
		const parts = { hour: Number(h), minute: Number(mi), second: Number(s) };
		checkRange('時', parts.hour, 0, 23);
		checkRange('分', parts.minute, 0, 59);
		checkRange('秒', parts.second, 0, 59);
		return resolveTimeOnly(parts, anchorTs);
	}

	throw new Error(`日時の形が違います: ${raw}（${SINCE_FORMAT_HELP}）`);
}
