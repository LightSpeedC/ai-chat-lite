//! 各コマンドの中身。
//!
//! 出力は node 版と 1 文字ずつ同じにする。桁は表示幅で揃える（日本語は半角 2 つ分）。

use crate::client::{CallError, Client};
use crate::json::Json;

/// 在席の印。node 版の `STATUS_MARK` と同じ
pub fn status_mark(status: &str) -> &'static str {
	match status {
		"online" => "●",
		"grace" => "◐",
		_ => "○",
	}
}

/// 接続先を短く表す。localhost なら `:ポート` だけにする
pub fn describe_place(display: &str) -> String {
	match display.strip_prefix("http://localhost:") {
		// ポートだけが続いているときに限る。パスが付いていれば全体を出す
		Some(port) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => format!(":{}", port),
		_ => display.to_string(),
	}
}

/// どちらの環境かを先に出す。
///
/// **取れなければ黙って諦める。**印は補助なので、ここで粘る意味がない。
/// 粘ると、使い方の誤りが「繋がらない待ち」に埋もれる。
pub fn announce_env(client: &Client) {
	// 版の確認は待たせない。3 秒で切る
	let timeout = Some(std::time::Duration::from_secs(3));
	let quiet = Client {
		base: client.base.clone(),
		access_token: client.access_token.clone(),
		retry_times: 0,
		retry_interval_sec: client.retry_interval_sec,
	};
	if let Ok(info) = quiet.call("GET", "/api/version", None, timeout) {
		let env = info.get("env").and_then(|v| v.as_str()).unwrap_or("");
		let label = if env == "test" { "テスト" } else { "本番" };
		eprintln!("{}（{}）", label, describe_place(&client.base.display));
	}
}

/// 発言の区切り。node 版の `SEPARATOR` と同じ
const SEPARATOR: &str = "────────";

/// 発言 1 件を整える。
///
/// **`say` 以外（参加・離脱・知らせ）は差出人を出さない。**本文だけで意味が通り、
/// 「誰が離脱したか」は本文に入っている。
pub fn format_message(m: &Json) -> String {
	let get = |key: &str| m.get(key).and_then(|v| v.as_str()).unwrap_or("");
	let seq = m.get("msg_seq").and_then(|v| v.as_i64()).unwrap_or(0);
	let head = format!("{} [{}] #{} {}", SEPARATOR, get("room_id"), seq, get("sent_at"));

	if get("msg_kind") != "say" {
		return format!("{}\n{}", head, get("msg_body"));
	}

	let to = match m.get("to_connector_id").and_then(|v| v.as_str()) {
		Some(id) if !id.is_empty() => format!(" @{}", id),
		_ => String::new(),
	};
	let reply = match m.get("reply_to_msg_seq").and_then(|v| v.as_i64()) {
		Some(n) if n > 0 => format!(" ↳#{}", n),
		_ => String::new(),
	};
	format!("{} {}{}{}\n{}", head, get("from_connector_id"), to, reply, get("msg_body"))
}

/// 発言を並べる。**1 件ごとに空行を挟む**
pub fn print_messages(messages: &[Json]) {
	for m in messages {
		println!();
		println!("{}", format_message(m));
	}
}

/// 絞り込みを人が読む形にする。何も無ければ「直近 」
pub fn describe_filter(since: Option<&str>, before: Option<&str>, find: Option<&str>, from: Option<&str>) -> String {
	let mut parts = Vec::new();
	// 日時は分までを出す（yyyy/mm/dd HH:MM の 16 文字）
	if let Some(s) = since {
		parts.push(format!("{} 以降", head16(s)));
	}
	if let Some(b) = before {
		parts.push(format!("{} より前", head16(b)));
	}
	if let Some(f) = find {
		parts.push(format!("「{}」を含む", f));
	}
	if let Some(f) = from {
		parts.push(format!("{} からの", f));
	}
	if parts.is_empty() {
		"直近 ".to_string()
	} else {
		format!(" {} ", parts.join("・"))
	}
}

/// 先頭 16 文字。文字の途中で切らない
fn head16(text: &str) -> String {
	text.chars().take(16).collect()
}

/// 問い合わせに載せる値を逃がす。
///
/// 外部クレートを使わないので自前で持つ。逃がさないのは、どの処理系でも
/// そのまま通ると決まっている文字だけにする。
pub fn encode_query(value: &str) -> String {
	let mut out = String::new();
	for b in value.as_bytes() {
		match b {
			b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(*b as char),
			_ => out.push_str(&format!("%{:02X}", b)),
		}
	}
	out
}

/// 参加者と状態を出す
pub fn who(client: &Client) -> Result<(), CallError> {
	let result = client.call("GET", "/api/connectors", None, None)?;
	let empty: Vec<Json> = Vec::new();
	let connectors = result.get("connectors").and_then(|v| v.as_arr()).unwrap_or(&empty);

	if connectors.is_empty() {
		println!("まだ誰も参加していません");
		return Ok(());
	}

	// ID の桁を揃える。node 版は文字数で数えている（ID は半角だけなので同じ値になる）
	let id_width = connectors
		.iter()
		.filter_map(|c| c.get("connector_id").and_then(|v| v.as_str()))
		.map(|s| s.chars().count())
		.max()
		.unwrap_or(0);

	println!("参加者:");
	for c in connectors {
		let get = |key: &str| c.get(key).and_then(|v| v.as_str()).unwrap_or("");
		let connected = c.get("connected").and_then(|v| v.as_bool()).unwrap_or(false);
		let count = c.get("active_connection_count").and_then(|v| v.as_i64()).unwrap_or(0);
		let conn = if connected { format!("接続 {}", count) } else { String::new() };

		/*
		 * 桁は文字数で詰める。表示幅ではない。
		 *
		 * node 版が String.padEnd を使っており、あれは文字数で数える。
		 * 「一時切断」は 4 文字（表示幅 8）なので、6 に詰めると空白が 2 つ付く。
		 * 表示幅で数えると 8 > 6 で何も付かず、1 文字ずつの一致が崩れる。
		 * Rust の {:<N} も文字数で数えるので、そのまま揃う。
		 */
		println!(
			"  {} {:<id_w$}  {:<6}  {:<5}  最終 {}  {}",
			status_mark(get("status")),
			get("connector_id"),
			get("status_label"),
			get("connector_role"),
			get("last_active_at"),
			conn,
			id_w = id_width
		);
	}
	Ok(())
}

/// `recent` に渡す絞り込み
pub struct RecentOpts {
	pub limit: i64,
	pub since: Option<String>,
	pub before: Option<String>,
	pub find: Option<String>,
	pub from: Option<String>,
	/// 絞り込みを 1 つでも指定したか
	pub has_filter: bool,
}

/// 直近の履歴を出す
pub fn recent(client: &Client, room: &str, opts: &RecentOpts) -> Result<(), CallError> {
	let mut query = format!("/api/history?room_id={}&limit={}", encode_query(room), opts.limit);
	if let Some(s) = &opts.since {
		query.push_str(&format!("&since_ts={}", encode_query(s)));
	}
	if let Some(b) = &opts.before {
		query.push_str(&format!("&before_ts={}", encode_query(b)));
	}
	if let Some(f) = &opts.find {
		query.push_str(&format!("&find={}", encode_query(f)));
	}
	if let Some(f) = &opts.from {
		query.push_str(&format!("&from_connector_id={}", encode_query(f)));
	}

	let result = client.call("GET", &query, None, None)?;
	let empty: Vec<Json> = Vec::new();
	let messages = result.get("messages").and_then(|v| v.as_arr()).unwrap_or(&empty);

	if messages.is_empty() {
		if opts.has_filter {
			println!("{} には該当する発言がありません", room);
		} else {
			println!("{} にはまだ何もありません", room);
		}
		return Ok(());
	}

	println!(
		"{} の{}{} 件:",
		room,
		describe_filter(
			opts.since.as_deref(),
			opts.before.as_deref(),
			opts.find.as_deref(),
			opts.from.as_deref()
		),
		messages.len()
	);
	print_messages(messages);
	Ok(())
}

/// 片付けの種別を人が読む形にする
pub fn archive_label(kind: &str) -> String {
	match kind {
		"message" => "発言".to_string(),
		"connector" => "参加者".to_string(),
		"room" => "ルーム".to_string(),
		// 知らない種別はそのまま出す。伏せるより読める
		other => other.to_string(),
	}
}

/// 片付けたものの一覧を出す
pub fn archives(client: &Client) -> Result<(), CallError> {
	let result = client.call("GET", "/api/admin/archives", None, None)?;
	let empty: Vec<Json> = Vec::new();
	let list = result.get("archives").and_then(|v| v.as_arr()).unwrap_or(&empty);

	if list.is_empty() {
		println!("片付けたものはありません。");
		return Ok(());
	}

	/*
	 * 対象（種別と id）を説明とは別の列で出す。
	 * 説明は --description で書き換えられるため、そこだけ見ても対象が分からない。
	 */
	let targets: Vec<String> = list
		.iter()
		.map(|a| {
			let kind = a.get("archive_kind").and_then(|v| v.as_str()).unwrap_or("");
			let id = a.get("archive_id").and_then(|v| v.as_str()).unwrap_or("");
			format!("{} {}", archive_label(kind), id)
		})
		.collect();

	// 見出しの「対象」も含めて桁を決める。node 版は 4 を下限にしている
	let w = targets.iter().map(|t| t.chars().count()).chain(std::iter::once(4)).max().unwrap_or(4);

	println!("  seq  片付けた日時             {:<w$}  件数  説明", "対象", w = w);
	for (i, a) in list.iter().enumerate() {
		let num = |key: &str| a.get(key).and_then(|v| v.as_i64()).unwrap_or(0);
		let count = num("msg_count") + num("cursor_count") + num("connector_count");
		println!(
			"{:>5}  {}  {:<w$}  {:>4}  {}",
			num("archived_seq"),
			a.get("archived_at").and_then(|v| v.as_str()).unwrap_or(""),
			targets[i],
			count,
			a.get("description").and_then(|v| v.as_str()).unwrap_or(""),
			w = w
		);
	}
	Ok(())
}

/// 全ルームの発言を JSONL に書き出す
pub fn dump(client: &Client, out: &std::path::Path) -> Result<(), CallError> {
	/*
	 * /api/dump はルームで絞らず、片付けたものも含めて全件を返す。
	 * 切り分けに使うものなので、見えているものだけでは足りない。
	 */
	let result = client.call("GET", "/api/dump", None, None)?;
	let empty: Vec<Json> = Vec::new();
	let messages = result.get("messages").and_then(|v| v.as_arr()).unwrap_or(&empty);

	let mut text = String::new();
	for m in messages {
		text.push_str(&m.to_string());
		text.push('\n');
	}

	if let Some(dir) = out.parent() {
		let _ = std::fs::create_dir_all(dir);
	}
	if let Err(e) = std::fs::write(out, text) {
		eprintln!("書き出せませんでした: {}", e);
		return Err(CallError::Rejected {
			status: 0,
			error: format!("書き出せませんでした: {}", e),
			detail: None,
		});
	}

	let archived = messages
		.iter()
		.filter(|m| m.get("archived_seq").map(|v| !v.is_null()).unwrap_or(false))
		.count();
	println!(
		"{} 件を書き出しました（片付けたもの {} 件を含む）: {}",
		messages.len(),
		archived,
		out.display()
	);
	Ok(())
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::json;

	fn msg(text: &str) -> Json {
		json::parse(text).unwrap()
	}

	#[test]
	fn 発言は差出人つきで整える() {
		let m = msg(r#"{"room_id":"public","msg_seq":12,"sent_at":"2026/09/13 10:00:00.000","msg_kind":"say","from_connector_id":"me","msg_body":"本文"}"#);
		assert_eq!(
			format_message(&m),
			"──────── [public] #12 2026/09/13 10:00:00.000 me\n本文"
		);
	}

	#[test]
	fn 名指しと返信の印を足す() {
		let m = msg(r#"{"room_id":"public","msg_seq":12,"sent_at":"2026/09/13 10:00:00.000","msg_kind":"say","from_connector_id":"me","to_connector_id":"you","reply_to_msg_seq":5,"msg_body":"本文"}"#);
		assert!(format_message(&m).contains("me @you ↳#5"), "{}", format_message(&m));
	}

	#[test]
	fn 参加や離脱は差出人を出さない() {
		// 本文だけで意味が通る。「誰が離脱したか」は本文に入っている
		let m = msg(r#"{"room_id":"public","msg_seq":3,"sent_at":"2026/09/13 10:00:00.000","msg_kind":"join","from_connector_id":"me","msg_body":"me が参加しました"}"#);
		assert_eq!(
			format_message(&m),
			"──────── [public] #3 2026/09/13 10:00:00.000\nme が参加しました"
		);
	}

	#[test]
	fn 空の宛先や返信は印を出さない() {
		let m = msg(r#"{"room_id":"public","msg_seq":1,"sent_at":"2026/09/13 10:00:00.000","msg_kind":"say","from_connector_id":"me","to_connector_id":null,"reply_to_msg_seq":null,"msg_body":"x"}"#);
		assert!(!format_message(&m).contains('@'), "宛先が無いのに @ が出た");
		assert!(!format_message(&m).contains('↳'), "返信でないのに ↳ が出た");
	}

	#[test]
	fn 絞り込みが無ければ直近と出す() {
		assert_eq!(describe_filter(None, None, None, None), "直近 ");
	}

	#[test]
	fn 絞り込みを並べる() {
		let text = describe_filter(Some("2026/09/13 10:00:00.000"), None, None, None);
		assert_eq!(text, " 2026/09/13 10:00 以降 ", "日時は分まで");

		let text = describe_filter(
			Some("2026/09/13 10:00:00.000"),
			Some("2026/09/14 10:00:00.000"),
			Some("語"),
			Some("me"),
		);
		assert_eq!(
			text,
			" 2026/09/13 10:00 以降・2026/09/14 10:00 より前・「語」を含む・me からの "
		);
	}

	#[test]
	fn 問い合わせの値を逃がす() {
		assert_eq!(encode_query("public"), "public");
		assert_eq!(encode_query("a b"), "a%20b");
		assert_eq!(encode_query("2026/09/13 10:00:00.000"), "2026%2F09%2F13%2010%3A00%3A00.000");
		// 日本語はバイトごとに逃がす
		assert_eq!(encode_query("あ"), "%E3%81%82");
		// そのまま通ると決まっている文字は触らない
		assert_eq!(encode_query("a-b_c.d~e"), "a-b_c.d~e");
	}

	#[test]
	fn 片付けの種別を言葉にする() {
		assert_eq!(archive_label("message"), "発言");
		assert_eq!(archive_label("connector"), "参加者");
		assert_eq!(archive_label("room"), "ルーム");
		// 知らない種別はそのまま出す。伏せるより読める
		assert_eq!(archive_label("知らない種別"), "知らない種別");
	}

	#[test]
	fn 在席の印を選ぶ() {
		assert_eq!(status_mark("online"), "●");
		assert_eq!(status_mark("grace"), "◐");
		assert_eq!(status_mark("offline"), "○");
		// 知らない状態は離席と同じ扱いにする。印が消えるより読める
		assert_eq!(status_mark("知らない状態"), "○");
	}

	#[test]
	fn localhostはポートだけにする() {
		assert_eq!(describe_place("http://localhost:8787"), ":8787");
	}

	#[test]
	fn localhost以外はそのまま出す() {
		assert_eq!(describe_place("http://192.168.0.2:9000"), "http://192.168.0.2:9000");
		assert_eq!(describe_place("http://example.test"), "http://example.test");
	}

	#[test]
	fn ポートでないものが続けばそのまま出す() {
		// http://localhost:8787/path のような形を ":8787/path" にしない
		assert_eq!(describe_place("http://localhost:abc"), "http://localhost:abc");
		assert_eq!(describe_place("http://localhost:"), "http://localhost:");
	}
}
