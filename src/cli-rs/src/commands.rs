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

#[cfg(test)]
mod tests {
	use super::*;

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
