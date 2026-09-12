//! HTTP/1.1 を手で書く。
//!
//! 外部クレートを使わないので、要求の組み立てと応答の読み取りを自前で持つ。
//! 相手は localhost のサーバー 1 つだけなので、必要なところに絞る。
//!
//! **`fetch` の轍は踏まない。**node の `fetch` は Windows で 1 往復ごとに
//! 15 ms ほど待たされる（課題 i260912-02）。ここは生のソケットに書くので、
//! その待ちは入らない。
//!
//! 組み立てと読み取りはソケットから切り離してある。そうしないと、
//! サーバーを立てないと確かめられなくなる。

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

/// 受け取った応答
#[derive(Debug, Clone, PartialEq)]
pub struct Response {
	pub status: u16,
	pub body: String,
}

/// 送る要求
pub struct Request<'a> {
	pub method: &'a str,
	/// パスと問い合わせ（`/api/poll?connector_id=...`）
	pub path: &'a str,
	pub host: &'a str,
	pub port: u16,
	/// 追加のヘッダ（名前, 値）
	pub headers: Vec<(String, String)>,
	/// 本文。`None` なら付けない
	pub body: Option<&'a str>,
}

/// 要求を 1 つの文字列に組み立てる
pub fn build_request(req: &Request) -> String {
	let mut out = format!("{} {} HTTP/1.1\r\n", req.method, req.path);
	out.push_str(&format!("Host: {}:{}\r\n", req.host, req.port));

	// 読み切る形にする。長さの解釈が要らず、実装が短くなる
	out.push_str("Connection: close\r\n");

	for (name, value) in &req.headers {
		out.push_str(&format!("{}: {}\r\n", name, value));
	}

	if let Some(body) = req.body {
		out.push_str("Content-Type: application/json\r\n");
		// 文字数ではなくバイト数。日本語は 1 文字 3 バイトで、文字数だと切れる
		out.push_str(&format!("Content-Length: {}\r\n", body.len()));
		out.push_str("\r\n");
		out.push_str(body);
	} else {
		out.push_str("\r\n");
	}
	out
}

/// 受け取ったバイト列から応答を取り出す
pub fn parse_response(raw: &[u8]) -> Result<Response, String> {
	// ヘッダと本文の境目は空行
	let split = find_subslice(raw, b"\r\n\r\n").ok_or_else(|| "ヘッダが閉じていません".to_string())?;
	let head = std::str::from_utf8(&raw[..split]).map_err(|_| "ヘッダが文字として読めません".to_string())?;
	let body_bytes = &raw[split + 4..];

	let mut lines = head.split("\r\n");
	let status_line = lines.next().ok_or_else(|| "状態行がありません".to_string())?;

	// HTTP/1.1 200 OK の真ん中を取る
	let status: u16 = status_line
		.split(' ')
		.nth(1)
		.and_then(|s| s.parse().ok())
		.ok_or_else(|| format!("状態行が読めません: {}", status_line))?;

	let mut headers = HashMap::new();
	for line in lines {
		if let Some((name, value)) = line.split_once(':') {
			headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
		}
	}

	// 分割して送られていれば繋ぐ。大小は問わない
	let chunked = header_of(&headers, "transfer-encoding")
		.map(|v| v.to_ascii_lowercase().contains("chunked"))
		.unwrap_or(false);

	let body = if chunked {
		decode_chunked(body_bytes)?
	} else if let Some(len) = header_of(&headers, "content-length").and_then(|v| v.parse::<usize>().ok()) {
		// 長さが分かっていればその分だけ。多く届いていても切る
		body_bytes[..len.min(body_bytes.len())].to_vec()
	} else {
		// 長さが無ければ、閉じるまでが本文
		body_bytes.to_vec()
	};

	Ok(Response {
		status,
		body: String::from_utf8_lossy(&body).into_owned(),
	})
}

/// 分割して送られた本文（chunked）を繋ぐ
fn decode_chunked(body: &[u8]) -> Result<Vec<u8>, String> {
	let mut out = Vec::new();
	let mut at = 0;

	loop {
		// 終わりの印（長さ 0）を見ないまま尽きたら、途中で切れている
		if at >= body.len() {
			return Err("分割の終わりが来ていません".to_string());
		}
		let line_end = find_subslice(&body[at..], b"\r\n").ok_or_else(|| "分割の長さが読めません".to_string())?;
		let size_text = std::str::from_utf8(&body[at..at + line_end])
			.map_err(|_| "分割の長さが文字として読めません".to_string())?;

		// 拡張（size;name=value）が付くことがある。長さだけを見る
		let size_text = size_text.split(';').next().unwrap_or("").trim();

		// 16 進で読む。10 を 10 バイトと読むと途中で切れる
		let size = usize::from_str_radix(size_text, 16)
			.map_err(|_| format!("分割の長さが 16 進ではありません: {}", size_text))?;

		at += line_end + 2;
		if size == 0 {
			return Ok(out);
		}
		if at + size > body.len() {
			return Err("分割の本文が途中で切れています".to_string());
		}
		out.extend_from_slice(&body[at..at + size]);

		// 各塊の後ろにも改行が付く
		at += size + 2;
	}
}

/// バイト列の中から並びを探す
fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
	if needle.is_empty() || haystack.len() < needle.len() {
		return None;
	}
	haystack.windows(needle.len()).position(|w| w == needle)
}

/// 1 往復する。`timeout` は読み書きの上限（long-poll では長く取る）
pub fn send(req: &Request, timeout: Option<Duration>) -> std::io::Result<Response> {
	let mut stream = TcpStream::connect((req.host, req.port))?;
	stream.set_read_timeout(timeout)?;
	stream.set_write_timeout(timeout)?;
	// 小さな要求を分けて送らない。往復のたびに遅延が乗る
	stream.set_nodelay(true)?;

	stream.write_all(build_request(req).as_bytes())?;
	stream.flush()?;

	let mut raw = Vec::new();
	stream.read_to_end(&mut raw)?;

	parse_response(&raw).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

/// ヘッダを大小を無視して引く
fn header_of<'a>(headers: &'a HashMap<String, String>, name: &str) -> Option<&'a str> {
	headers.get(&name.to_ascii_lowercase()).map(|s| s.as_str())
}

#[cfg(test)]
mod tests {
	use super::*;

	fn req<'a>(method: &'a str, path: &'a str, body: Option<&'a str>) -> Request<'a> {
		Request {
			method,
			path,
			host: "127.0.0.1",
			port: 8787,
			headers: vec![],
			body,
		}
	}

	#[test]
	fn 要求の1行目と必須のヘッダが入る() {
		let text = build_request(&req("GET", "/api/who", None));
		let lines: Vec<&str> = text.split("\r\n").collect();
		assert_eq!(lines[0], "GET /api/who HTTP/1.1");
		assert!(text.contains("Host: 127.0.0.1:8787"), "Host が無い: {}", text);
		// 読み切る形にする。長さの解釈が要らず、実装が短くなる
		assert!(text.contains("Connection: close"), "Connection が無い: {}", text);
		// ヘッダの終わりは空行 1 つ
		assert!(text.ends_with("\r\n\r\n"), "空行で終わっていない");
	}

	#[test]
	fn 本文があれば長さと型を付ける() {
		let text = build_request(&req("POST", "/api/say", Some(r#"{"a":1}"#)));
		assert!(text.contains("Content-Type: application/json"), "型が無い: {}", text);
		assert!(text.contains("Content-Length: 7"), "長さが無い: {}", text);
		assert!(text.ends_with(r#"{"a":1}"#), "本文が末尾に無い");
	}

	#[test]
	fn 本文の長さはバイトで数える() {
		// 日本語は 1 文字 3 バイト。文字数で数えると足りずに切れる。
		// {"a":"あ"} は 9 文字だが、あ が 3 バイトなので 11 バイトになる
		let body = r#"{"a":"あ"}"#;
		assert_eq!(body.chars().count(), 9, "文字数");
		assert_eq!(body.len(), 11, "バイト数");
		let text = build_request(&req("POST", "/api/say", Some(body)));
		assert!(text.contains("Content-Length: 11"), "バイト数で数えていない: {}", text);
	}

	#[test]
	fn 本文が無ければ長さを付けない() {
		let text = build_request(&req("GET", "/api/who", None));
		assert!(!text.contains("Content-Length"), "GET に長さが付いている");
	}

	#[test]
	fn 追加のヘッダを載せる() {
		let mut r = req("GET", "/api/who", None);
		r.headers.push(("X-AiChat-Access-Token".to_string(), "abc".to_string()));
		let text = build_request(&r);
		assert!(text.contains("X-AiChat-Access-Token: abc"), "{}", text);
	}

	#[test]
	fn 長さつきの応答を読む() {
		let raw = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 7\r\n\r\n{\"a\":1}";
		let res = parse_response(raw).unwrap();
		assert_eq!(res.status, 200);
		assert_eq!(res.body, r#"{"a":1}"#);
	}

	#[test]
	fn 長さが無ければ最後まで読む() {
		// Connection: close で返ってくる形
		let raw = b"HTTP/1.1 200 OK\r\n\r\n{\"a\":1}";
		let res = parse_response(raw).unwrap();
		assert_eq!(res.body, r#"{"a":1}"#);
	}

	#[test]
	fn 分割された本文を繋ぐ() {
		let raw = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\n{\"a\"\r\n3\r\n:1}\r\n0\r\n\r\n";
		let res = parse_response(raw).unwrap();
		assert_eq!(res.body, r#"{"a":1}"#);
	}

	#[test]
	fn ヘッダの大小を問わない() {
		let raw = b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\n{}";
		assert_eq!(parse_response(raw).unwrap().body, "{}");

		let raw = b"HTTP/1.1 200 OK\r\nTRANSFER-ENCODING: CHUNKED\r\n\r\n2\r\n{}\r\n0\r\n\r\n";
		assert_eq!(parse_response(raw).unwrap().body, "{}");
	}

	#[test]
	fn エラーの状態も読む() {
		let raw = b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 2\r\n\r\n{}";
		let res = parse_response(raw).unwrap();
		assert_eq!(res.status, 503);
	}

	#[test]
	fn 日本語の本文を読める() {
		let body = r#"{"msg_body":"こんにちは"}"#;
		let raw = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{}", body.len(), body);
		let res = parse_response(raw.as_bytes()).unwrap();
		assert_eq!(res.body, body);
	}

	#[test]
	fn 本文が空でも読める() {
		let raw = b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n";
		let res = parse_response(raw).unwrap();
		assert_eq!(res.status, 204);
		assert_eq!(res.body, "");
	}

	#[test]
	fn 壊れた応答は理由を返す() {
		assert!(parse_response(b"").is_err(), "空");
		assert!(parse_response(b"HTTP/1.1 200 OK").is_err(), "ヘッダが閉じていない");
		assert!(parse_response("ぐちゃぐちゃ\r\n\r\n".as_bytes()).is_err(), "状態行が読めない");
	}

	#[test]
	fn 分割の終わりが無ければ理由を返す() {
		let raw = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\n{\"a\"";
		assert!(parse_response(raw).is_err());
	}

	#[test]
	fn 分割の長さを16進で読む() {
		// 10 は 16 進なので 16 バイト。10 バイトと読むと途中で切れる
		let chunk = "0123456789abcdef";
		let raw = format!("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n10\r\n{}\r\n0\r\n\r\n", chunk);
		assert_eq!(parse_response(raw.as_bytes()).unwrap().body, chunk);
	}
}
