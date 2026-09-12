//! JSON の読み書き。
//!
//! 外部クレートを使わない方針なので自前で持つ。C# 版の `Json.cs` と同じ役目。
//!
//! オブジェクトは `Vec` で持ち、**書かれた順を保つ**。`HashMap` にすると
//! 出力のたびにキーの並びが変わり、node 版との突き合わせができなくなる。
//!
//! 数を `f64` 1 本で持つのは JSON の仕様に合わせたため。`msg_seq` のような
//! 整数は `as_i64()` で取り出す。

use std::collections::VecDeque;
use std::fmt::Write as _;

#[derive(Debug, Clone, PartialEq)]
pub enum Json {
	Null,
	Bool(bool),
	Num(f64),
	Str(String),
	Arr(Vec<Json>),
	Obj(Vec<(String, Json)>),
}

impl Json {
	/// オブジェクトから鍵を引く。オブジェクトでなければ `None`
	pub fn get(&self, key: &str) -> Option<&Json> {
		match self {
			Json::Obj(pairs) => pairs.iter().find(|(k, _)| k == key).map(|(_, v)| v),
			_ => None,
		}
	}

	/// 文字列として取り出す。違う型なら `None`
	pub fn as_str(&self) -> Option<&str> {
		match self {
			Json::Str(s) => Some(s),
			_ => None,
		}
	}

	/// 数として取り出す
	pub fn as_f64(&self) -> Option<f64> {
		match self {
			Json::Num(n) => Some(*n),
			_ => None,
		}
	}

	/// 整数として取り出す。小数は切り捨てない（整数でなければ `None`）
	pub fn as_i64(&self) -> Option<i64> {
		match self {
			Json::Num(n) if n.fract() == 0.0 => Some(*n as i64),
			_ => None,
		}
	}

	pub fn as_bool(&self) -> Option<bool> {
		match self {
			Json::Bool(b) => Some(*b),
			_ => None,
		}
	}

	pub fn as_arr(&self) -> Option<&[Json]> {
		match self {
			Json::Arr(items) => Some(items),
			_ => None,
		}
	}

	pub fn is_null(&self) -> bool {
		matches!(self, Json::Null)
	}

	/// 文字列に書き出す。空白を入れない（送る用）
	pub fn to_string(&self) -> String {
		let mut out = String::new();
		write_json(&mut out, self);
		out
	}
}

/// JSON の文字列を読む。読めなければ理由を返す。
pub fn parse(text: &str) -> Result<Json, String> {
	let mut chars: VecDeque<char> = text.chars().collect();
	skip_space(&mut chars);
	let value = parse_value(&mut chars)?;
	skip_space(&mut chars);
	if !chars.is_empty() {
		return Err(format!("余分な文字があります: {}", chars.iter().take(16).collect::<String>()));
	}
	Ok(value)
}

fn skip_space(chars: &mut VecDeque<char>) {
	while let Some(c) = chars.front() {
		if c.is_whitespace() {
			chars.pop_front();
		} else {
			break;
		}
	}
}

fn parse_value(chars: &mut VecDeque<char>) -> Result<Json, String> {
	match chars.front() {
		None => Err("値がありません".to_string()),
		Some('{') => parse_obj(chars),
		Some('[') => parse_arr(chars),
		Some('"') => parse_str(chars).map(Json::Str),
		Some('t') => expect_word(chars, "true").map(|_| Json::Bool(true)),
		Some('f') => expect_word(chars, "false").map(|_| Json::Bool(false)),
		Some('n') => expect_word(chars, "null").map(|_| Json::Null),
		Some(_) => parse_num(chars),
	}
}

fn expect_word(chars: &mut VecDeque<char>, word: &str) -> Result<(), String> {
	for want in word.chars() {
		match chars.pop_front() {
			Some(got) if got == want => {}
			_ => return Err(format!("{} ではありません", word)),
		}
	}
	Ok(())
}

fn parse_obj(chars: &mut VecDeque<char>) -> Result<Json, String> {
	chars.pop_front(); // '{'
	let mut pairs = Vec::new();
	skip_space(chars);
	if chars.front() == Some(&'}') {
		chars.pop_front();
		return Ok(Json::Obj(pairs));
	}
	loop {
		skip_space(chars);
		let key = parse_str(chars)?;
		skip_space(chars);
		if chars.pop_front() != Some(':') {
			return Err(format!("鍵 {} のあとに : がありません", key));
		}
		skip_space(chars);
		let value = parse_value(chars)?;
		pairs.push((key, value));
		skip_space(chars);
		match chars.pop_front() {
			Some(',') => continue,
			Some('}') => return Ok(Json::Obj(pairs)),
			_ => return Err("オブジェクトが閉じていません".to_string()),
		}
	}
}

fn parse_arr(chars: &mut VecDeque<char>) -> Result<Json, String> {
	chars.pop_front(); // '['
	let mut items = Vec::new();
	skip_space(chars);
	if chars.front() == Some(&']') {
		chars.pop_front();
		return Ok(Json::Arr(items));
	}
	loop {
		skip_space(chars);
		items.push(parse_value(chars)?);
		skip_space(chars);
		match chars.pop_front() {
			Some(',') => continue,
			Some(']') => return Ok(Json::Arr(items)),
			_ => return Err("配列が閉じていません".to_string()),
		}
	}
}

fn parse_str(chars: &mut VecDeque<char>) -> Result<String, String> {
	if chars.pop_front() != Some('"') {
		return Err("文字列の始まりが \" ではありません".to_string());
	}
	let mut out = String::new();
	loop {
		match chars.pop_front() {
			None => return Err("文字列が閉じていません".to_string()),
			Some('"') => return Ok(out),
			Some('\\') => match chars.pop_front() {
				Some('"') => out.push('"'),
				Some('\\') => out.push('\\'),
				Some('/') => out.push('/'),
				Some('b') => out.push('\u{0008}'),
				Some('f') => out.push('\u{000C}'),
				Some('n') => out.push('\n'),
				Some('r') => out.push('\r'),
				Some('t') => out.push('\t'),
				Some('u') => out.push(parse_unicode(chars)?),
				other => return Err(format!("知らない逃げ方です: {:?}", other)),
			},
			Some(c) => out.push(c),
		}
	}
}

/// 4 桁の 16 進で書かれた文字を読む。上位・下位の代理対（サロゲートペア）も繋ぐ
fn parse_unicode(chars: &mut VecDeque<char>) -> Result<char, String> {
	let high = take_hex4(chars)?;

	// 単独で文字になる範囲
	if !(0xD800..0xDC00).contains(&high) {
		return char::from_u32(high).ok_or_else(|| format!("文字にできません: U+{:04X}", high));
	}

	// 上位の代理。続く 4 桁と組にして 1 文字にする
	if chars.pop_front() != Some('\\') || chars.pop_front() != Some('u') {
		return Err("代理対の後半がありません".to_string());
	}
	let low = take_hex4(chars)?;
	if !(0xDC00..0xE000).contains(&low) {
		return Err(format!("代理対の後半が範囲外です: U+{:04X}", low));
	}
	let combined = 0x10000 + ((high - 0xD800) << 10) + (low - 0xDC00);
	char::from_u32(combined).ok_or_else(|| format!("文字にできません: U+{:04X}", combined))
}

fn take_hex4(chars: &mut VecDeque<char>) -> Result<u32, String> {
	let mut value = 0u32;
	for _ in 0..4 {
		let c = chars.pop_front().ok_or_else(|| "逃がした文字の桁が足りません".to_string())?;
		let digit = c.to_digit(16).ok_or_else(|| format!("16 進ではありません: {}", c))?;
		value = value * 16 + digit;
	}
	Ok(value)
}

fn parse_num(chars: &mut VecDeque<char>) -> Result<Json, String> {
	let mut text = String::new();
	while let Some(&c) = chars.front() {
		if c.is_ascii_digit() || "+-.eE".contains(c) {
			text.push(c);
			chars.pop_front();
		} else {
			break;
		}
	}
	text.parse::<f64>().map(Json::Num).map_err(|_| format!("数として読めません: {}", text))
}

fn write_json(out: &mut String, value: &Json) {
	match value {
		Json::Null => out.push_str("null"),
		Json::Bool(true) => out.push_str("true"),
		Json::Bool(false) => out.push_str("false"),
		Json::Num(n) => {
			// 整数は小数点を付けずに出す。msg_seq が 12.0 になると読む側が困る
			if n.fract() == 0.0 && n.abs() < 9.007_199_254_740_992e15 {
				let _ = write!(out, "{}", *n as i64);
			} else {
				let _ = write!(out, "{}", n);
			}
		}
		Json::Str(s) => write_str(out, s),
		Json::Arr(items) => {
			out.push('[');
			for (i, item) in items.iter().enumerate() {
				if i > 0 {
					out.push(',');
				}
				write_json(out, item);
			}
			out.push(']');
		}
		Json::Obj(pairs) => {
			out.push('{');
			for (i, (k, v)) in pairs.iter().enumerate() {
				if i > 0 {
					out.push(',');
				}
				write_str(out, k);
				out.push(':');
				write_json(out, v);
			}
			out.push('}');
		}
	}
}

fn write_str(out: &mut String, s: &str) {
	out.push('"');
	for c in s.chars() {
		match c {
			'"' => out.push_str("\\\""),
			'\\' => out.push_str("\\\\"),
			'\n' => out.push_str("\\n"),
			'\r' => out.push_str("\\r"),
			'\t' => out.push_str("\\t"),
			'\u{0008}' => out.push_str("\\b"),
			'\u{000C}' => out.push_str("\\f"),
			// 残りの制御文字は 4 桁の 16 進に逃がす。日本語はそのまま出す（UTF-8 で送る）
			c if (c as u32) < 0x20 => {
				let _ = write!(out, "\\u{:04x}", c as u32);
			}
			c => out.push(c),
		}
	}
	out.push('"');
}

#[cfg(test)]
mod tests {
	use super::*;

	/// 文字コードから 1 文字を作る。
	///
	/// **ソースに生の制御文字を置かない**ための道具。置くと、編集の道具を
	/// 通るたびに壊れる（実際に 2 度壊れた）。
	fn ctrl(code: u32) -> String {
		char::from_u32(code).unwrap().to_string()
	}

	/// 逃がした形（バックスラッシュ ＋ u ＋ 4 桁）を組み立てる。
	///
	/// **リテラルで書かない**。その並びをソースに置くと、編集の道具が
	/// 文字コードとして解釈して生の制御文字に変えてしまう。
	fn escaped(hex: &str) -> String {
		format!("{}u{}", '\\', hex)
	}

	#[test]
	fn 空のオブジェクトと配列を読める() {
		assert_eq!(parse("{}").unwrap(), Json::Obj(vec![]));
		assert_eq!(parse("[]").unwrap(), Json::Arr(vec![]));
	}

	#[test]
	fn オブジェクトは書かれた順を保つ() {
		// HashMap にすると並びが変わり、node 版との突き合わせができなくなる
		let parsed = parse(r#"{"z":1,"a":2,"m":3}"#).unwrap();
		match &parsed {
			Json::Obj(pairs) => {
				let keys: Vec<&str> = pairs.iter().map(|(k, _)| k.as_str()).collect();
				assert_eq!(keys, vec!["z", "a", "m"]);
			}
			other => panic!("オブジェクトではありません: {:?}", other),
		}
		assert_eq!(parsed.to_string(), r#"{"z":1,"a":2,"m":3}"#);
	}

	#[test]
	fn 整数は小数点を付けずに書き出す() {
		// msg_seq が 12.0 になると、受け取る側が整数として読めない
		assert_eq!(Json::Num(12.0).to_string(), "12");
		assert_eq!(Json::Num(-3.0).to_string(), "-3");
		assert_eq!(Json::Num(1.5).to_string(), "1.5");
	}

	#[test]
	fn 日本語はそのまま書き出す() {
		// 逃がさない。UTF-8 で送るので逃がす必要がない
		let value = Json::Str("こんにちは".to_string());
		assert_eq!(value.to_string(), "\"こんにちは\"");
	}

	#[test]
	fn 引用符と改行とタブを逃がす() {
		let value = Json::Str("a\"b\\c\nd\te".to_string());
		assert_eq!(value.to_string(), r#""a\"b\\c\nd\te""#);
	}

	#[test]
	fn 制御文字は4桁の16進に逃がす() {
		let value = Json::Str(format!("x{}y", ctrl(1)));
		assert_eq!(value.to_string(), format!("\"x{}y\"", escaped("0001")));

		// 退避（0x08）と改ページ（0x0C）は専用の逃げ方を持つ
		assert_eq!(Json::Str(ctrl(8)).to_string(), r#""\b""#);
		assert_eq!(Json::Str(ctrl(12)).to_string(), r#""\f""#);
	}

	#[test]
	fn 逃がした文字を読み戻せる() {
		let parsed = parse(r#""a\"b\\c\nd\te""#).unwrap();
		assert_eq!(parsed.as_str().unwrap(), "a\"b\\c\nd\te");
	}

	#[test]
	fn 逃がした制御文字を読み戻せる() {
		let text = format!("\"x{}y\"", escaped("0001"));
		let parsed = parse(&text).unwrap();
		assert_eq!(parsed.as_str().unwrap(), format!("x{}y", ctrl(1)));
	}

	#[test]
	fn 書いて読むと元に戻る() {
		// 逃がし方と読み方が食い違っていないかを、往復させて確かめる
		let original = format!("引用\" 逆斜線\\ 改行\n タブ\t 制御{} 絵文字😀", ctrl(1));
		let written = Json::Str(original.clone()).to_string();
		assert_eq!(parse(&written).unwrap().as_str().unwrap(), original);
	}

	#[test]
	fn 代理対を1文字に繋ぐ() {
		// 絵文字は上位と下位の 2 つに分かれて届くことがある
		let text = format!("\"{}{}\"", escaped("d83d"), escaped("de00"));
		let parsed = parse(&text).unwrap();
		assert_eq!(parsed.as_str().unwrap(), "😀");
	}

	#[test]
	fn 入れ子を読んで書き戻すと同じになる() {
		let text = r#"{"a":[1,2,{"b":null,"c":true}],"d":"x"}"#;
		assert_eq!(parse(text).unwrap().to_string(), text);
	}

	#[test]
	fn 鍵を引ける() {
		let parsed = parse(r#"{"msg_seq":42,"from":"ai","ok":false}"#).unwrap();
		assert_eq!(parsed.get("msg_seq").unwrap().as_i64(), Some(42));
		assert_eq!(parsed.get("from").unwrap().as_str(), Some("ai"));
		assert_eq!(parsed.get("ok").unwrap().as_bool(), Some(false));
		assert!(parsed.get("無い鍵").is_none());
	}

	#[test]
	fn 小数は整数として取り出せない() {
		assert_eq!(Json::Num(1.5).as_i64(), None);
		assert_eq!(Json::Num(2.0).as_i64(), Some(2));
	}

	#[test]
	fn 空白を跨いで読める() {
		let text = "{\n\t\"a\" : [ 1 , 2 ]\n}";
		assert_eq!(parse(text).unwrap().to_string(), r#"{"a":[1,2]}"#);
	}

	#[test]
	fn 壊れた入力は理由を返す() {
		assert!(parse("{").is_err());
		assert!(parse("{\"a\":}").is_err());
		assert!(parse("[1,2").is_err());
		assert!(parse(r#"{"a":1}x"#).is_err());
		assert!(parse("").is_err());
	}
}
