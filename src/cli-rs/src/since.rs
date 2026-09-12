//! `recent --since` ・ `--before` の日時を解決する。
//!
//! node 版の `since-parse.mjs` ・ C# 版の `SinceParse.cs` と同じ規則にする。
//!
//! **`--since` と `--before` は同じ関数を使う。**分けると、組み合わせたときに
//! 片方だけ丸まって範囲が壊れる。`--since 11/1 --before 11/30` で `--since` だけ
//! 丸めると、去年 11 月から今年 11 月末までという意図しない範囲になる。
//!
//! **`--before` は `--since` が決めた値を引き継ぐ。**「未来なら 1 つ遡る」を
//! `--before` にも独立に当てはめると、`--since 9/9 --before 9/10`（今日と明日）が
//! 「今日から去年の 9/10 まで」になる。`anchor` を渡すと、省いた分はそこから採る。
//!
//! 書式は 3 段。上から順に試し、最初に形が合ったものを使う。
//!
//!   ① yyyy/m/d[区切り H:m[:s]]  年月日（＋任意で時刻）
//!   ② m/d[区切り H:m[:s]]       月日（年を省く）
//!   ③ H:m[:s]                   時刻のみ（日付を省く）
//!
//! 区切りは半角スペース・ハイフン・下線のどれでもよい。ハイフンと下線なら
//! コマンドラインでダブルクォートが要らない。
//!
//! 外部クレートを使わないので正規表現は持たない。桁と区切りを手で見る。

use crate::jst;

/// 読み手にも使い方にも出す、書式の説明
pub const FORMAT_HELP: &str =
	"日時は yyyy/m/d ・ m/d ・ H:m の 3 段のどれかです（時刻は任意で追加。区切りは半角スペース・ハイフン・下線）";

const MS_PER_DAY: i64 = 24 * 60 * 60 * 1000;

/// 日付と時刻の区切り
fn is_sep(c: char) -> bool {
	c == ' ' || c == '-' || c == '_'
}

/// `--since` ・ `--before` の値を、`sent_at` と同じ書式に直す。
///
/// * `anchor` … `--before` のとき、`--since` 側が決めた値。`--since` 自身には渡さない
pub fn resolve(raw: &str, anchor: Option<&str>) -> Result<String, String> {
	resolve_with_now(raw, anchor, &jst::now_jst())
}

/// 「いま」を渡して解決する。テストから時刻を固定するために分けてある
pub fn resolve_with_now(raw: &str, anchor: Option<&str>, now: &str) -> Result<String, String> {
	/*
	 * 形が合わないときと、形は合うが範囲の外のときで、返す言葉を分ける。
	 *
	 * node 版は 3 段の正規表現でどれにも当たらなければ「形が違います」の 1 つだけを
	 * 返す。桁や区切りの誤りをそこで細かく言い分けると、2 本の文言が食い違う。
	 */
	let shape = || format!("日時の形が違います: {}（{}）", raw, FORMAT_HELP);

	let (date_text, time_text) = split_sep(raw);

	// ③ 時刻のみ。区切りを持たず、`/` も無い
	if time_text.is_none() && !date_text.contains('/') {
		if !looks_like_time(date_text) {
			return Err(shape());
		}
		let t = parse_time(date_text)?;
		return resolve_time_only(t, anchor, now);
	}

	let t = match time_text {
		Some(text) => {
			if !looks_like_time(text) {
				return Err(shape());
			}
			parse_time(text)?
		}
		None => Time { hour: 0, minute: 0, second: 0 },
	};

	let date_parts: Vec<&str> = date_text.split('/').collect();
	match date_parts.as_slice() {
		// ① 年月日。年は 4 桁に限る
		[y, mo, d] => {
			if !is_digits(y, 4, 4) || !is_digits(mo, 1, 2) || !is_digits(d, 1, 2) {
				return Err(shape());
			}
			let year: i64 = y.parse().map_err(|_| shape())?;
			let month = parse_num(mo, "月", 1, 12)?;
			let day = parse_num(d, "日", 1, 31)?;
			check_day_of_month(year, month, day)?;
			// 指定しきっているので丸めない（anchor も見ない）
			Ok(jst::from_parts(year, month, day, t.hour, t.minute, t.second))
		}
		// ② 月日
		[mo, d] => {
			if !is_digits(mo, 1, 2) || !is_digits(d, 1, 2) {
				return Err(shape());
			}
			let month = parse_num(mo, "月", 1, 12)?;
			let day = parse_num(d, "日", 1, 31)?;
			resolve_month_day(month, day, t, anchor, now)
		}
		_ => Err(shape()),
	}
}

/// 桁数の範囲に収まる数字だけでできているか
fn is_digits(text: &str, min_len: usize, max_len: usize) -> bool {
	text.len() >= min_len && text.len() <= max_len && text.bytes().all(|b| b.is_ascii_digit())
}

/// `H:m` ・ `H:m:s` の形をしているか。値の範囲はここでは見ない
fn looks_like_time(text: &str) -> bool {
	let parts: Vec<&str> = text.split(':').collect();
	match parts.as_slice() {
		[h, mi] => is_digits(h, 1, 2) && is_digits(mi, 1, 2),
		[h, mi, s] => is_digits(h, 1, 2) && is_digits(mi, 1, 2) && is_digits(s, 1, 2),
		_ => false,
	}
}

#[derive(Clone, Copy)]
struct Time {
	hour: u32,
	minute: u32,
	second: u32,
}

/// 最初の区切りで日付と時刻に分ける
fn split_sep(raw: &str) -> (&str, Option<&str>) {
	match raw.char_indices().find(|(_, c)| is_sep(*c)) {
		Some((i, c)) => (&raw[..i], Some(&raw[i + c.len_utf8()..])),
		None => (raw, None),
	}
}

/// `H:m[:s]` を読む
fn parse_time(text: &str) -> Result<Time, String> {
	let parts: Vec<&str> = text.split(':').collect();
	let (h, mi, s) = match parts.as_slice() {
		[h, mi] => (*h, *mi, "0"),
		[h, mi, s] => (*h, *mi, *s),
		_ => return Err(format!("時刻の形が違います: {}（{}）", text, FORMAT_HELP)),
	};
	Ok(Time {
		hour: parse_num(h, "時", 0, 23)?,
		minute: parse_num(mi, "分", 0, 59)?,
		second: parse_num(s, "秒", 0, 59)?,
	})
}

/// 1〜2 桁の数を読み、範囲も見る
fn parse_num(text: &str, name: &str, min: u32, max: u32) -> Result<u32, String> {
	if text.is_empty() || text.len() > 2 || !text.bytes().all(|b| b.is_ascii_digit()) {
		return Err(format!("{}が数ではありません: {}", name, text));
	}
	let value: u32 = text.parse().map_err(|_| format!("{}が数ではありません: {}", name, text))?;
	if value < min || value > max {
		return Err(format!("{}は {}〜{} の範囲にしてください: {}", name, min, max, value));
	}
	Ok(value)
}

/// 桁数を決めて数を読む（年は 4 桁に限る）
fn parse_fixed(text: &str, digits: usize, name: &str) -> Result<i64, String> {
	if text.len() != digits || !text.bytes().all(|b| b.is_ascii_digit()) {
		return Err(format!("{}は {} 桁の数にしてください: {}", name, digits, text));
	}
	text.parse::<i64>().map_err(|_| format!("{}が数ではありません: {}", name, text))
}

/// JST の文字列から年月日を取り出す
fn date_parts(jst_text: &str) -> Result<(i64, u32, u32), String> {
	let date = jst_text.split(' ').next().unwrap_or("");
	let parts: Vec<&str> = date.split('/').collect();
	match parts.as_slice() {
		[y, mo, d] => Ok((
			y.parse().map_err(|_| format!("年が読めません: {}", jst_text))?,
			mo.parse().map_err(|_| format!("月が読めません: {}", jst_text))?,
			d.parse().map_err(|_| format!("日が読めません: {}", jst_text))?,
		)),
		_ => Err(format!("日時の形が違います: {}", jst_text)),
	}
}

/// ② 月日（年を省く）を決める。
///
/// 基準があればその年をそのまま使う。無ければ「いま」の年を使い、
/// 組み立てた結果が未来なら 1 年遡る。
///
/// **日数の検査は年が決まってから行う。**2/29 は年によって有無が変わる。
fn resolve_month_day(month: u32, day: u32, t: Time, anchor: Option<&str>, now: &str) -> Result<String, String> {
	if let Some(a) = anchor {
		let (year, _, _) = date_parts(a)?;
		check_day_of_month(year, month, day)?;
		return Ok(jst::from_parts(year, month, day, t.hour, t.minute, t.second));
	}

	let (year, _, _) = date_parts(now)?;
	check_day_of_month(year, month, day)?;
	let candidate = jst::from_parts(year, month, day, t.hour, t.minute, t.second);

	// 文字列のまま比べる。この書式は固定長なので、辞書順がそのまま時系列順になる
	if candidate.as_str() <= now {
		return Ok(candidate);
	}
	check_day_of_month(year - 1, month, day)?;
	Ok(jst::from_parts(year - 1, month, day, t.hour, t.minute, t.second))
}

/// ③ 時刻のみ（日付を省く）を決める。
///
/// 基準があればその年月日をそのまま使う。無ければ「今日」を使い、
/// 組み立てた結果が未来なら 1 日遡る。
fn resolve_time_only(t: Time, anchor: Option<&str>, now: &str) -> Result<String, String> {
	let source = anchor.unwrap_or(now);
	let (year, month, day) = date_parts(source)?;
	let candidate = jst::from_parts(year, month, day, t.hour, t.minute, t.second);

	if anchor.is_some() || candidate.as_str() <= now {
		return Ok(candidate);
	}
	// 月・年をまたぐ繰り下がりは日付の計算に任せる
	jst::shift(&candidate, -MS_PER_DAY)
}

/// その年・その月の最終日
fn days_in_month(year: i64, month: u32) -> u32 {
	match month {
		1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
		4 | 6 | 9 | 11 => 30,
		2 if is_leap(year) => 29,
		2 => 28,
		_ => 0,
	}
}

/// 閏年か。4 年ごと、ただし 100 年ごとは除き、400 年ごとは戻す
fn is_leap(year: i64) -> bool {
	(year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

/// その月に無い日を断る。
///
/// 日の検査は 1〜31 までしか見ていないので、ここを素通りさせると翌月へ
/// 繰り上がり、打った日付とは別の範囲を静かに返すことになる。
/// **2 月は年で日数が変わるので、年が決まってから呼ぶ。**
fn check_day_of_month(year: i64, month: u32, day: u32) -> Result<(), String> {
	let last = days_in_month(year, month);
	if day > last {
		return Err(format!("{} 月は {} 日までです（{} 年）: {}/{}", month, last, year, month, day));
	}
	Ok(())
}

#[cfg(test)]
mod tests {
	use super::*;

	/// テストの基準時刻。2026/09/13（日）12:00
	const NOW: &str = "2026/09/13 12:00:00.000";

	fn at(raw: &str) -> String {
		resolve_with_now(raw, None, NOW).unwrap_or_else(|e| panic!("{} が読めません: {}", raw, e))
	}

	fn at_anchor(raw: &str, anchor: &str) -> String {
		resolve_with_now(raw, Some(anchor), NOW).unwrap_or_else(|e| panic!("{} が読めません: {}", raw, e))
	}

	#[test]
	fn 年月日と時刻を読む() {
		assert_eq!(at("2026/9/13 10:30"), "2026/09/13 10:30:00.000");
		assert_eq!(at("2026/9/13 10:30:45"), "2026/09/13 10:30:45.000");
	}

	#[test]
	fn 年月日だけなら午前0時になる() {
		assert_eq!(at("2026/9/13"), "2026/09/13 00:00:00.000");
	}

	#[test]
	fn 区切りは3種類とも使える() {
		// ハイフンと下線ならコマンドラインでダブルクォートが要らない
		assert_eq!(at("2026/9/13-10:30"), "2026/09/13 10:30:00.000");
		assert_eq!(at("2026/9/13_10:30"), "2026/09/13 10:30:00.000");
		assert_eq!(at("2026/9/13 10:30"), "2026/09/13 10:30:00.000");
	}

	#[test]
	fn 年月日を全部指定したら未来でも丸めない() {
		// 指定しきっているので、遡る理由がない
		assert_eq!(at("2030/1/1"), "2030/01/01 00:00:00.000");
	}

	#[test]
	fn 月日だけなら今年を使う() {
		assert_eq!(at("9/1"), "2026/09/01 00:00:00.000");
	}

	#[test]
	fn 月日が未来なら去年に遡る() {
		// 9/14 は明日。まだ来ていない日を範囲の始まりにしても意味がない
		assert_eq!(at("9/14"), "2025/09/14 00:00:00.000");
		assert_eq!(at("12/31"), "2025/12/31 00:00:00.000");
	}

	#[test]
	fn 時刻だけなら今日を使う() {
		assert_eq!(at("9:00"), "2026/09/13 09:00:00.000");
		assert_eq!(at("11:59:59"), "2026/09/13 11:59:59.000");
	}

	#[test]
	fn 時刻が未来なら昨日に遡る() {
		// いまが 12:00 なので 13:00 はまだ来ていない
		assert_eq!(at("13:00"), "2026/09/12 13:00:00.000");
	}

	#[test]
	fn 時刻が未来で月initialをまたぐ() {
		// 月の初日に遡ると前の月になる
		assert_eq!(
			resolve_with_now("13:00", None, "2026/09/01 12:00:00.000").unwrap(),
			"2026/08/31 13:00:00.000"
		);
	}

	#[test]
	fn 基準があれば年を引き継いで遡らない() {
		// --since 11/1 --before 11/30 のとき、11/30 は 11/1 と同じ年にする
		let since = at("11/1"); // 未来なので 2025 年
		assert_eq!(since, "2025/11/01 00:00:00.000");
		assert_eq!(at_anchor("11/30", &since), "2025/11/30 00:00:00.000");
	}

	#[test]
	fn 基準があれば日付を引き継いで遡らない() {
		// --since 9/9 --before 9/10 のような「今日と明日」を壊さない
		let since = at("9/13 10:00");
		assert_eq!(at_anchor("13:00", &since), "2026/09/13 13:00:00.000");
	}

	#[test]
	fn 基準があっても年月日を全部指定したら効かない() {
		let since = at("2020/1/1");
		assert_eq!(at_anchor("2026/9/13", &since), "2026/09/13 00:00:00.000");
	}

	#[test]
	fn 存在しない日を断る() {
		// ここを素通りさせると翌月へ繰り上がり、打った日付と違う範囲になる
		assert!(resolve_with_now("2026/2/30", None, NOW).is_err());
		assert!(resolve_with_now("2026/4/31", None, NOW).is_err());
		assert!(resolve_with_now("2026/2/29", None, NOW).is_err(), "2026 は閏年ではない");
		assert!(resolve_with_now("2024/2/29", None, NOW).is_ok(), "2024 は閏年");
	}

	#[test]
	fn 月日だけのときも年が決まってから日数を見る() {
		// 2/29 は年によって有無が変わる。2026 年に無いので 1 つ遡って 2024 …
		// ではなく、遡った先（2025）にも無いので断る
		assert!(resolve_with_now("2/29", None, NOW).is_err());
		// 2024 年を基準にすれば通る
		assert_eq!(
			resolve_with_now("2/29", None, "2024/06/01 12:00:00.000").unwrap(),
			"2024/02/29 00:00:00.000"
		);
	}

	#[test]
	fn 範囲の外を断る() {
		assert!(resolve_with_now("2026/13/1", None, NOW).is_err(), "13 月");
		assert!(resolve_with_now("2026/0/1", None, NOW).is_err(), "0 月");
		assert!(resolve_with_now("2026/1/0", None, NOW).is_err(), "0 日");
		assert!(resolve_with_now("2026/1/32", None, NOW).is_err(), "32 日");
		assert!(resolve_with_now("24:00", None, NOW).is_err(), "24 時");
		assert!(resolve_with_now("10:60", None, NOW).is_err(), "60 分");
		assert!(resolve_with_now("10:30:60", None, NOW).is_err(), "60 秒");
	}

	#[test]
	fn 形が違えば断る() {
		assert!(resolve_with_now("", None, NOW).is_err());
		assert!(resolve_with_now("きのう", None, NOW).is_err());
		assert!(resolve_with_now("2026-09-13", None, NOW).is_err(), "ハイフン区切りの日付");
		assert!(resolve_with_now("20260913", None, NOW).is_err());
		assert!(resolve_with_now("9/", None, NOW).is_err());
		assert!(resolve_with_now("9/13 10", None, NOW).is_err(), "時刻に : が無い");
		assert!(resolve_with_now("026/9/13", None, NOW).is_err(), "年が 3 桁");
	}

	#[test]
	fn 月末の日数を数えられる() {
		assert_eq!(days_in_month(2026, 1), 31);
		assert_eq!(days_in_month(2026, 2), 28);
		assert_eq!(days_in_month(2024, 2), 29, "4 年規則");
		assert_eq!(days_in_month(2000, 2), 29, "400 年規則");
		assert_eq!(days_in_month(2100, 2), 28, "100 年規則");
		assert_eq!(days_in_month(2026, 4), 30);
		assert_eq!(days_in_month(2026, 12), 31);
	}

	#[test]
	fn 無い日は理由を返す() {
		let err = check_day_of_month(2026, 2, 30).unwrap_err();
		assert!(err.contains("2 月"), "何月かを書く: {}", err);
		assert!(err.contains("28"), "何日までかを書く: {}", err);
		assert!(check_day_of_month(2026, 2, 28).is_ok());
	}

	#[test]
	fn 一日の差はミリ秒でも保たれる() {
		// 遡るときに日付だけを引くと、時刻の端で 1 ミリ秒ずれることがある
		let a = resolve_with_now("23:59:59", None, "2026/09/13 00:00:00.000").unwrap();
		assert_eq!(a, "2026/09/12 23:59:59.000");
		let _ = MS_PER_DAY;
	}
}
