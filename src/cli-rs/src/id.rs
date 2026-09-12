//! 名乗る ID の検証と、囲みの剥がし方。
//!
//! **囲むのは ID どうしの前方一致を止めるため。**囲みが無いと `project-a` を
//! 探す式が `project-aa` にも当たり、1 本しか張っていない待受けが 2 本に見える。
//! それを二重と誤認して片方を止めると、相手は原因不明の `exit 255` で落ちる
//! （課題 i260901-07 で実際に起きた）。
//!
//! **囲みはコマンドラインの書き方であって、値の一部ではない。**読んだ直後に
//! 剥がし、以降は裸の ID だけを扱う。API へ送る値・ログ・画面はすべて裸にする。
//!
//! 使える文字は定義の `id_pattern` が持つが、外部クレートを使わないので
//! 正規表現は動かせない。**同じ規則を手で書く。**食い違わないよう、
//! 定義の文字列と突き合わせるテストを置いてある。

/// ID に使える文字か。英数字・ハイフン・下線・ピリオド
fn is_allowed(c: char) -> bool {
	c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.'
}

/// ID として通るか。
///
/// 規則は 3 つ。
///   ・1 文字以上
///   ・使えるのは英数字・ハイフン・下線・ピリオド
///   ・**ピリオドは先頭と末尾に置けない**
///
/// 末尾のピリオドを断るのは、Windows がファイル名の末尾のピリオドを落とすため。
/// 待受けのログが `logs/client/yyyymmdd-hhmmss-<ID>.log` に入るので、
/// 許すと名前が食い違う。先頭も禁じ、`.` や `-` だけの ID と見分けやすくする。
pub fn is_valid(id: &str) -> bool {
	if id.is_empty() {
		return false;
	}
	if !id.chars().all(is_allowed) {
		return false;
	}
	// ピリオドは先頭と末尾に置けない
	!id.starts_with('.') && !id.ends_with('.')
}

/// 囲みを剥がす。囲まれていない・使えない文字が入っていれば理由を返す。
///
/// * `wrap` … 囲みの記号（定義の `id_wrap`）
/// * `where_` … どこで受け取ったか（案内に出す）
pub fn unwrap(raw: &str, wrap: &str, where_: &str) -> Result<String, String> {
	// 囲みの長さ 2 つぶんより長いこと。:: は中身が空なので通さない
	if raw.len() > wrap.len() * 2 && raw.starts_with(wrap) && raw.ends_with(wrap) {
		let id = &raw[wrap.len()..raw.len() - wrap.len()];
		if is_valid(id) {
			return Ok(id.to_string());
		}
		return Err(format!(
			"ID に使えない文字が入っています（{}）: {}\n  \
			 使えるのは英数字・ハイフン・下線・ピリオドだけです。ピリオドは先頭と末尾には置けません。",
			where_, raw
		));
	}

	Err(format!(
		"ID は {} で囲んでください（{}）: {}\n  例: {}{}{}",
		wrap,
		where_,
		raw,
		wrap,
		raw.replace(wrap, ""),
		wrap
	))
}

/// 囲みの有無を問わずに読む。
///
/// `--from` はこちらを使う。`--to` や `waiters` の囲み必須は「前方一致で探す式に
/// 埋め込むため」の制約だが、`--from` は完全一致の条件にするだけなので要らない。
pub fn unwrap_flexible(raw: &str, wrap: &str, where_: &str) -> Result<String, String> {
	// 囲まれていれば剥がし、そうでなければそのまま見る
	let id = if raw.len() > wrap.len() * 2 && raw.starts_with(wrap) && raw.ends_with(wrap) {
		&raw[wrap.len()..raw.len() - wrap.len()]
	} else {
		raw
	};

	if is_valid(id) {
		return Ok(id.to_string());
	}
	Err(format!(
		"ID に使えない文字が入っています（{}）: {}\n  \
		 使えるのは英数字・ハイフン・下線・ピリオドだけです。ピリオドは先頭と末尾には置けません。",
		where_, raw
	))
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::definition::Definition;

	#[test]
	fn 使える文字を通す() {
		assert!(is_valid("ai-chat-lite"));
		assert!(is_valid("project_a"));
		assert!(is_valid("a.b.c"));
		assert!(is_valid("A1"));
		assert!(is_valid("x"), "1 文字でもよい");
	}

	#[test]
	fn 使えない文字を断る() {
		assert!(!is_valid(""), "空");
		assert!(!is_valid("a b"), "空白");
		assert!(!is_valid("a:b"), "囲みの記号");
		assert!(!is_valid("あ"), "日本語");
		assert!(!is_valid("a/b"), "記号");
		assert!(!is_valid("a\"b"), "引用符");
	}

	#[test]
	fn ピリオドは先頭と末尾に置けない() {
		// Windows がファイル名の末尾のピリオドを落とすため、待受けのログの
		// 名前が食い違う
		assert!(!is_valid(".a"), "先頭");
		assert!(!is_valid("a."), "末尾");
		assert!(!is_valid("."), "1 文字のピリオド");
		assert!(is_valid("a.b"), "途中なら通る");
	}

	#[test]
	fn 記号だけのIDも通る() {
		// node 版で実測して合わせた。ピリオド以外なら 1 文字でも記号でも通る
		assert!(is_valid("-"));
		assert!(is_valid("_"));
		assert!(is_valid("--"));
	}

	#[test]
	fn 手で書いた規則が定義と食い違っていない() {
		// 正規表現は動かせないので同じ規則を手で書いている。
		// 定義の文字列が変わったら、ここで気づけるようにする
		let def = Definition::load().unwrap();
		assert_eq!(
			def.id_pattern, "^[A-Za-z0-9_-](?:[A-Za-z0-9_.-]*[A-Za-z0-9_-])?$",
			"定義が変わった。is_valid を合わせ直すこと"
		);
	}

	#[test]
	fn 囲みを剥がす() {
		assert_eq!(unwrap(":me:", ":", "コマンドの直後").unwrap(), "me");
		assert_eq!(unwrap(":ai-chat-lite:", ":", "--to").unwrap(), "ai-chat-lite");
	}

	#[test]
	fn 囲まれていなければ断る() {
		let err = unwrap("me", ":", "コマンドの直後").unwrap_err();
		assert!(err.contains("囲んでください"), "何をすべきかを書く: {}", err);
		assert!(err.contains(":me:"), "直した形を見本に出す: {}", err);
	}

	#[test]
	fn 片方だけの囲みを断る() {
		assert!(unwrap(":me", ":", "x").is_err());
		assert!(unwrap("me:", ":", "x").is_err());
	}

	#[test]
	fn 囲みだけを断る() {
		// :: は中身が空。囲みの長さ 2 つぶんより長いことを見る
		assert!(unwrap("::", ":", "x").is_err());
		assert!(unwrap(":", ":", "x").is_err());
	}

	#[test]
	fn 囲みの中が使えない文字なら断る() {
		let err = unwrap(":a b:", ":", "--to").unwrap_err();
		assert!(err.contains("使えない文字"), "理由を書く: {}", err);
		assert!(err.contains("--to"), "どこで受け取ったかを書く: {}", err);
	}

	#[test]
	fn 囲みの有無を問わない読み方もある() {
		// --from は完全一致の条件にするだけなので、囲みを要求しない
		assert_eq!(unwrap_flexible(":me:", ":", "--from").unwrap(), "me");
		assert_eq!(unwrap_flexible("me", ":", "--from").unwrap(), "me");
	}

	#[test]
	fn 囲みを問わない場合も使えない文字は断る() {
		assert!(unwrap_flexible("a b", ":", "--from").is_err());
		assert!(unwrap_flexible(":a b:", ":", "--from").is_err());
	}
}
