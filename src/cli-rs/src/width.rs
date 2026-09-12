//! 表示幅で桁を揃える。
//!
//! **日本語は半角 2 つ分の幅で表示される。**文字数で揃えると、日本語を含む行だけ
//! 右にずれる。node 版・C# 版と同じ数え方をしないと、出力が 1 文字ずつ一致しない。
//!
//! 数え方は node 版に合わせる。`[ -~]`（半角スペースからチルダまで）だけを 1 と
//! 数え、それ以外はすべて 2 と数える。**絵文字や合字を正しく数えることは目指さない。**
//! 2 本の CLI が同じ値を出すことのほうが大事で、そこだけを揃える。

/// 表示幅。半角を 1、それ以外を 2 と数える
pub fn width(text: &str) -> usize {
	text.chars().map(|c| if (' '..='~').contains(&c) { 1 } else { 2 }).sum()
}

/// 表示幅で右に詰める
pub fn pad_end(text: &str, w: usize) -> String {
	let mut out = text.to_string();
	out.push_str(&" ".repeat(w.saturating_sub(width(text))));
	out
}

/// 表示幅で左に詰める
pub fn pad_start(text: &str, w: usize) -> String {
	format!("{}{}", " ".repeat(w.saturating_sub(width(text))), text)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn 半角は1つ分() {
		assert_eq!(width("abc"), 3);
		assert_eq!(width("a b"), 3);
		assert_eq!(width("~"), 1);
		assert_eq!(width(" "), 1);
		// node 版で実測: --port(6) + 空白(1) + <(1) + ポート(6) + >(1) = 15
		assert_eq!(width("--port <ポート>"), 15, "混ざった場合");
		assert_eq!(width("--room <id[,id]>"), 16, "記号はすべて半角");
	}

	#[test]
	fn 日本語は2つ分() {
		assert_eq!(width("あ"), 2);
		assert_eq!(width("参加者"), 6);
		assert_eq!(width("片付ける"), 8);
	}

	#[test]
	fn 半角の外は2つ分として数える() {
		// 正しく数えることは目指さない。2 本の CLI が同じ値を出すことを優先する
		assert_eq!(width("😀"), 2);
		assert_eq!(width("…"), 2);
	}

	#[test]
	fn 空なら0() {
		assert_eq!(width(""), 0);
	}

	#[test]
	fn 右に詰める() {
		assert_eq!(pad_end("ab", 5), "ab   ");
		assert_eq!(pad_end("あ", 5), "あ   ", "全角は 2 つ分として詰める");
		assert_eq!(pad_end("abcde", 3), "abcde", "足りていれば足さない");
	}

	#[test]
	fn 左に詰める() {
		assert_eq!(pad_start("12", 5), "   12");
		assert_eq!(pad_start("あ", 5), "   あ");
	}
}
