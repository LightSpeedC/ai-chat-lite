//! JST（日本標準時）の文字列を組み立てる。
//!
//! 書式は `yyyy/mm/dd HH:mm:ss.fff`。サーバーの `sent_at` と同じスラッシュ区切りで、
//! node 版の `nowJst()` ・ C# 版の `JstTime` と 1 文字ずつ揃える。
//!
//! **OS のタイムゾーン設定を見ない。**UTC に 9 時間足すだけにする。見に行くと、
//! 走らせた機械の設定で値が変わり、同じ発言が別の時刻に見える。
//!
//! 暦の計算は自前で持つ（外部クレートを使わない方針のため）。

const MS_PER_SEC: i64 = 1000;
const MS_PER_MIN: i64 = 60 * MS_PER_SEC;
const MS_PER_HOUR: i64 = 60 * MS_PER_MIN;
const MS_PER_DAY: i64 = 24 * MS_PER_HOUR;

/// JST と UTC の差
const JST_OFFSET_MS: i64 = 9 * MS_PER_HOUR;

/// いまの JST を `yyyy/mm/dd HH:mm:ss.fff` で返す
pub fn now_jst() -> String {
	from_epoch_ms(now_epoch_ms() + JST_OFFSET_MS)
}

/// 指定ミリ秒前の JST を返す（`recent --since-day` ・ `--since-hour` 用）
pub fn before(ms: i64) -> String {
	from_epoch_ms(now_epoch_ms() + JST_OFFSET_MS - ms)
}

/// JST の年月日時分秒から、`now_jst()` と同じ書式を組み立てる
pub fn from_parts(year: i64, month: u32, day: u32, hour: u32, minute: u32, second: u32) -> String {
	let days = days_from_civil(year, month, day);
	let ms = days * MS_PER_DAY
		+ hour as i64 * MS_PER_HOUR
		+ minute as i64 * MS_PER_MIN
		+ second as i64 * MS_PER_SEC;
	from_epoch_ms(ms)
}

/// `now_jst()` と同じ書式の文字列を、指定ミリ秒だけずらして返す
pub fn shift(jst: &str, delta_ms: i64) -> Result<String, String> {
	Ok(from_epoch_ms(parse_jst(jst)? + delta_ms))
}

/// `now_jst()` と同じ書式の文字列を読み、JST としてのミリ秒に直す
///
/// 書式は 1 つだけ受け取る。ハイフン区切りや秒までの形は断る。
/// 受け取る形を増やすと、どちらで書かれたものか分からなくなる。
pub fn parse_jst(jst: &str) -> Result<i64, String> {
	let b = jst.as_bytes();
	if b.len() != 23 || b[4] != b'/' || b[7] != b'/' || b[10] != b' ' || b[13] != b':' || b[16] != b':' || b[19] != b'.' {
		return Err(format!("yyyy/mm/dd HH:mm:ss.fff の形ではありません: {}", jst));
	}
	let num = |from: usize, to: usize| -> Result<i64, String> {
		jst[from..to].parse::<i64>().map_err(|_| format!("数として読めません: {}", &jst[from..to]))
	};
	let year = num(0, 4)?;
	let month = num(5, 7)?;
	let day = num(8, 10)?;
	let hour = num(11, 13)?;
	let minute = num(14, 16)?;
	let second = num(17, 19)?;
	let milli = num(20, 23)?;

	if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 || second > 59 {
		return Err(format!("日時として成り立ちません: {}", jst));
	}

	Ok(days_from_civil(year, month as u32, day as u32) * MS_PER_DAY
		+ hour * MS_PER_HOUR
		+ minute * MS_PER_MIN
		+ second * MS_PER_SEC
		+ milli)
}

/// JST としてのミリ秒を `yyyy/mm/dd HH:mm:ss.fff` に直す
pub fn from_epoch_ms(ms: i64) -> String {
	// 負の側でも切り下げる。単純な除算だと 0 に向かって丸まり、1970 年より
	// 前の時刻が 1 日ずれる
	let days = ms.div_euclid(MS_PER_DAY);
	let rest = ms.rem_euclid(MS_PER_DAY);

	let (year, month, day) = civil_from_days(days);
	let hour = rest / MS_PER_HOUR;
	let minute = rest % MS_PER_HOUR / MS_PER_MIN;
	let second = rest % MS_PER_MIN / MS_PER_SEC;
	let milli = rest % MS_PER_SEC;

	format!(
		"{:04}/{:02}/{:02} {:02}:{:02}:{:02}.{:03}",
		year, month, day, hour, minute, second, milli
	)
}

/// いまの UTC を、1970-01-01 からのミリ秒で返す
fn now_epoch_ms() -> i64 {
	use std::time::{SystemTime, UNIX_EPOCH};
	match SystemTime::now().duration_since(UNIX_EPOCH) {
		Ok(d) => d.as_millis() as i64,
		// 機械の時計が 1970 年より前を指している場合。負の側で数える
		Err(e) => -(e.duration().as_millis() as i64),
	}
}

/*
 * 暦の計算。
 *
 * 3 月を年の初めと見なすと、閏日が年の末尾に来て場合分けが消える。
 * 400 年（146097 日）を 1 まとまりとして数え、その中の位置から年月日を割り出す。
 */

/// 1970-01-01 からの日数を (年, 月, 日) に直す
fn civil_from_days(days: i64) -> (i64, u32, u32) {
	// 0000-03-01 を起点に取り直す
	let z = days + 719468;
	let era = if z >= 0 { z } else { z - 146096 } / 146097;
	let doe = (z - era * 146097) as i64; // 400 年の中での日数 [0, 146096]
	let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // [0, 399]
	let y = yoe + era * 400;
	let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // 3 月 1 日からの日数 [0, 365]
	let mp = (5 * doy + 2) / 153; // 3 月を 0 とした月 [0, 11]
	let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
	let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
	(if m <= 2 { y + 1 } else { y }, m, d)
}

/// (年, 月, 日) を 1970-01-01 からの日数に直す
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
	let y = if month <= 2 { year - 1 } else { year };
	let era = if y >= 0 { y } else { y - 399 } / 400;
	let yoe = y - era * 400; // [0, 399]
	let mp = if month > 2 { month - 3 } else { month + 9 } as i64; // [0, 11]
	let doy = (153 * mp + 2) / 5 + day as i64 - 1; // [0, 365]
	let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
	era * 146097 + doe - 719468
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn 元期は日本時間の午前9時になる() {
		// 1970-01-01T00:00:00Z は JST で同じ日の 09:00。9 時間足すだけという
		// 考え方が効いていることを、いちばん単純な値で確かめる
		assert_eq!(from_epoch_ms(0 + JST_OFFSET_MS), "1970/01/01 09:00:00.000");
	}

	#[test]
	fn 月日時分秒をゼロで埋める() {
		assert_eq!(from_parts(2026, 1, 2, 3, 4, 5), "2026/01/02 03:04:05.000");
	}

	#[test]
	fn 閏日を扱える() {
		// 2024 は 400 年規則でも 4 年規則でも閏年
		assert_eq!(from_parts(2024, 2, 29, 12, 34, 56), "2024/02/29 12:34:56.000");
		// 2100 は 100 年規則で閏年ではない。3 月 1 日が 2 月 29 日にならないこと
		assert_eq!(from_parts(2100, 3, 1, 0, 0, 0), "2100/03/01 00:00:00.000");
	}

	#[test]
	fn 年をまたいで繰り上がる() {
		let end = from_parts(2024, 12, 31, 23, 59, 59);
		assert_eq!(shift(&end, 1000).unwrap(), "2025/01/01 00:00:00.000");
	}

	#[test]
	fn ミリ秒の単位でずらせる() {
		let base = from_parts(2026, 9, 13, 10, 0, 0);
		assert_eq!(shift(&base, 1).unwrap(), "2026/09/13 10:00:00.001");
		assert_eq!(shift(&base, -1).unwrap(), "2026/09/13 09:59:59.999");
	}

	#[test]
	fn 一日ずらすと同じ時刻の前日になる() {
		let base = from_parts(2026, 3, 1, 12, 0, 0);
		assert_eq!(shift(&base, -MS_PER_DAY).unwrap(), "2026/02/28 12:00:00.000");
	}

	#[test]
	fn 読んで書くと元に戻る() {
		// 書式の組み立てと読み取りが食い違っていないかを往復で確かめる
		for text in [
			"1970/01/01 09:00:00.000",
			"2024/02/29 12:34:56.789",
			"2026/09/13 23:59:59.999",
			"2100/03/01 00:00:00.000",
		] {
			let ms = parse_jst(text).unwrap();
			assert_eq!(from_epoch_ms(ms), text, "往復で変わった: {}", text);
		}
	}

	#[test]
	fn 書式が違えば読まない() {
		// ハイフン区切りは受け取らない。サーバーはスラッシュで持っている
		assert!(parse_jst("2026-09-13 10:00:00.000").is_err());
		assert!(parse_jst("2026/09/13 10:00:00").is_err());
		assert!(parse_jst("").is_err());
		assert!(parse_jst("いつか").is_err());
	}

	#[test]
	fn いまの時刻は決まった長さで返る() {
		let now = now_jst();
		assert_eq!(now.len(), 23, "yyyy/mm/dd HH:mm:ss.fff は 23 文字: {}", now);
		assert_eq!(now.as_bytes()[4], b'/');
		assert_eq!(now.as_bytes()[7], b'/');
		assert_eq!(now.as_bytes()[10], b' ');
		assert_eq!(now.as_bytes()[13], b':');
		assert_eq!(now.as_bytes()[16], b':');
		assert_eq!(now.as_bytes()[19], b'.');
	}

	#[test]
	fn 指定ミリ秒前はいまより前になる() {
		let now = now_jst();
		let ago = before(MS_PER_HOUR);
		assert!(ago < now, "1 時間前が現在より後になっている: {} / {}", ago, now);
	}
}
