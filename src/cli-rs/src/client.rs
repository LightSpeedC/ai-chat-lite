//! サーバーを呼ぶ。繋がらないときとメンテナンス中のときは繋ぎ直す。
//!
//! node 版の `call()` ・ C# 版の `Client.cs` と同じ振る舞いにする。
//!
//! **出すのは始めの 1 行と、諦めたときの 1 行だけ。**黙ると固まったように
//! 見えるが、60 回すべて出すと 60 行になる。

use std::time::Duration;

use crate::http::{self, Request};
use crate::json::{self, Json};

/// 接続先。`--url` はホストごと、`--port` は localhost のポートだけを変える
#[derive(Debug, Clone, PartialEq)]
pub struct Base {
	pub host: String,
	pub port: u16,
	/// 案内に出すときの形（`http://localhost:8787`）
	pub display: String,
}

/// 呼び出しの失敗
#[derive(Debug)]
pub enum CallError {
	/// 繋がらない・メンテナンスのまま諦めた。終了コードは定義の `exit_unreachable`
	Unreachable { reason: String },
	/// サーバーが断った（4xx ・ 5xx）。終了コードは 1
	Rejected { status: u16, error: String, detail: Option<String> },
}

/// `--url` ・ `--port` から接続先を決める。
///
/// **既定値を持たない。**渡されなければ `Ok(None)` を返し、繋ぐ直前に止める。
/// 既定を本番のポートにすると、テストのつもりで叩いたものが本番に入る。
/// 実際にそれが起きた。
pub fn resolve_base(url: Option<&str>, port: Option<&str>) -> Result<Option<Base>, String> {
	if url.is_some() && port.is_some() {
		return Err("--url と --port は同時に指定できません。どちらか一方にしてください。".to_string());
	}

	if let Some(raw) = url {
		let trimmed = raw.trim_end_matches('/');
		let rest = trimmed
			.strip_prefix("http://")
			.ok_or_else(|| format!("--url は http:// から書いてください: {}", raw))?;

		// ホストとポートに分ける。パスは持たない（API のパスは呼ぶ側が足す）
		let (host, port_text) = match rest.split_once(':') {
			Some((h, p)) => (h, Some(p)),
			None => (rest, None),
		};
		if host.is_empty() {
			return Err(format!("--url にホストがありません: {}", raw));
		}
		let port = match port_text {
			Some(p) => parse_port(p)?,
			None => 80,
		};
		return Ok(Some(Base {
			host: host.to_string(),
			port,
			display: trimmed.to_string(),
		}));
	}

	if let Some(raw) = port {
		let port = parse_port(raw)?;
		return Ok(Some(Base {
			host: "localhost".to_string(),
			port,
			display: format!("http://localhost:{}", port),
		}));
	}

	Ok(None)
}

/// 1 回の呼び出しをどう扱うかの判定
#[derive(Debug, PartialEq)]
pub enum Verdict {
	/// そのまま返してよい
	Done,
	/// 繋ぎ直す。理由は案内に出す
	Retry(String),
	/// サーバーが断った。もう粘らない
	Rejected,
}

/// 応答の状態から、繋ぎ直すかどうかを決める。
///
/// **メンテナンス中（503）は落ちているのではないので、同じように粘る。**
/// 繋がらないときと同じ扱いにしないと、入れ替えのたびに待受けが落ちる。
pub fn verdict_of(status: u16) -> Verdict {
	match status {
		200..=299 => Verdict::Done,
		503 => Verdict::Retry("メンテナンス中".to_string()),
		_ => Verdict::Rejected,
	}
}

/// サーバーとのやり取りを 1 つにまとめたもの
pub struct Client {
	pub base: Base,
	pub access_token: Option<String>,
	/// 繋ぎ直す回数。コマンドで変わる
	pub retry_times: i64,
	pub retry_interval_sec: i64,
}

impl Client {
	/// 繋ぎ直しを何秒おきに何回するかを、人が読む形にする
	pub fn describe_retry(&self) -> String {
		let total = self.retry_times * self.retry_interval_sec;
		format!("{} 秒おきに {} 回（最大 {} 秒）", self.retry_interval_sec, self.retry_times, total)
	}

	/// API を 1 回叩く。繋ぎ直しはしない
	fn call_once(&self, method: &str, path: &str, body: Option<&str>, timeout: Option<Duration>) -> std::io::Result<http::Response> {
		let mut headers = Vec::new();
		if let Some(token) = &self.access_token {
			headers.push(("X-AiChat-Access-Token".to_string(), token.clone()));
		}
		http::send(
			&Request {
				method,
				path,
				host: &self.base.host,
				port: self.base.port,
				headers,
				body,
			},
			timeout,
		)
	}

	/// API を叩き、JSON を返す。繋がらないときとメンテナンス中は繋ぎ直す。
	///
	/// `timeout` は読み書きの上限。long-poll では待つ長さより十分に長く取る。
	pub fn call(&self, method: &str, path: &str, body: Option<&str>, timeout: Option<Duration>) -> Result<Json, CallError> {
		let mut announced = false;
		let mut last_reason = String::new();

		for attempt in 0..=self.retry_times {
			if attempt > 0 {
				std::thread::sleep(Duration::from_secs(self.retry_interval_sec as u64));
			}

			let res = match self.call_once(method, path, body, timeout) {
				Ok(res) => res,
				Err(err) => {
					last_reason = format!("繋がりません（{}）", err.kind());
					if !announced && self.retry_times > 0 {
						eprintln!("サーバーに繋がりません: {}", self.base.display);
						eprintln!("  {}繋ぎ直します", self.describe_retry());
						announced = true;
					}
					continue;
				}
			};

			let parsed = json::parse(&res.body).unwrap_or(Json::Obj(vec![]));

			match verdict_of(res.status) {
				Verdict::Done => return Ok(parsed),
				Verdict::Retry(_) => {
					let detail = parsed
						.get("detail")
						.and_then(|v| v.as_str())
						.unwrap_or("理由の記載なし")
						.to_string();
					last_reason = format!("メンテナンス中です（{}）", detail);
					if !announced && self.retry_times > 0 {
						eprintln!("メンテナンス中です: {}", detail);
						eprintln!("  {}繋ぎ直します", self.describe_retry());
						announced = true;
					}
					continue;
				}
				Verdict::Rejected => {
					return Err(CallError::Rejected {
						status: res.status,
						error: parsed
							.get("error")
							.and_then(|v| v.as_str())
							.unwrap_or("不明")
							.to_string(),
						detail: parsed.get("detail").and_then(|v| v.as_str()).map(|s| s.to_string()),
					})
				}
			}
		}

		Err(CallError::Unreachable { reason: last_reason })
	}
}

/// ポートを読む。数だけを受け取る
fn parse_port(raw: &str) -> Result<u16, String> {
	if raw.is_empty() || !raw.bytes().all(|b| b.is_ascii_digit()) {
		return Err(format!("--port には数だけを渡してください: {}", raw));
	}
	let value: u32 = raw.parse().map_err(|_| format!("--port には数だけを渡してください: {}", raw))?;
	if !(1..=65535).contains(&value) {
		return Err(format!("ポートは 1〜65535 の範囲にしてください: {}", raw));
	}
	Ok(value as u16)
}

#[cfg(test)]
mod tests {
	use super::*;

	fn base(url: Option<&str>, port: Option<&str>) -> Base {
		resolve_base(url, port).unwrap().expect("接続先が決まらなかった")
	}

	#[test]
	fn ポートからlocalhostを組み立てる() {
		let b = base(None, Some("8787"));
		assert_eq!(b.host, "localhost");
		assert_eq!(b.port, 8787);
		assert_eq!(b.display, "http://localhost:8787");
	}

	#[test]
	fn URLをそのまま使う() {
		let b = base(Some("http://192.168.0.2:9000"), None);
		assert_eq!(b.host, "192.168.0.2");
		assert_eq!(b.port, 9000);
		assert_eq!(b.display, "http://192.168.0.2:9000");
	}

	#[test]
	fn URLの末尾のスラッシュを落とす() {
		let b = base(Some("http://localhost:8787/"), None);
		assert_eq!(b.display, "http://localhost:8787");
		let b = base(Some("http://localhost:8787///"), None);
		assert_eq!(b.display, "http://localhost:8787");
	}

	#[test]
	fn URLのポートを省いたら80になる() {
		let b = base(Some("http://localhost"), None);
		assert_eq!(b.port, 80);
	}

	#[test]
	fn 両方渡したら断る() {
		// 黙って片方を優先すると、書いたつもりの側が効かずに気づけない
		let err = resolve_base(Some("http://localhost:1"), Some("2")).unwrap_err();
		assert!(err.contains("同時に指定できません"), "{}", err);
	}

	#[test]
	fn どちらも無ければ決まらない() {
		// 既定を本番のポートにすると、テストのつもりが本番に入る
		assert_eq!(resolve_base(None, None).unwrap(), None);
	}

	#[test]
	fn ポートが数でなければ断る() {
		let err = resolve_base(None, Some("八千")).unwrap_err();
		assert!(err.contains("数だけ"), "{}", err);
		assert!(resolve_base(None, Some("0")).is_err(), "0 は使えない");
		assert!(resolve_base(None, Some("65536")).is_err(), "範囲の外");
		assert!(resolve_base(None, Some("-1")).is_err(), "負の数");
	}

	#[test]
	fn 知らない仕組みのURLを断る() {
		assert!(resolve_base(Some("https://example.com"), None).is_err(), "https は持たない");
		assert!(resolve_base(Some("localhost:8787"), None).is_err(), "http:// が無い");
	}

	#[test]
	fn 成功はそのまま返す() {
		assert_eq!(verdict_of(200), Verdict::Done);
		assert_eq!(verdict_of(201), Verdict::Done);
		assert_eq!(verdict_of(204), Verdict::Done);
	}

	#[test]
	fn メンテナンス中は繋ぎ直す() {
		// 落ちているのではないので、繋がらないときと同じように粘る。
		// 断る扱いにすると、入れ替えのたびに待受けが落ちる
		assert_eq!(verdict_of(503), Verdict::Retry("メンテナンス中".to_string()));
	}

	#[test]
	fn 断られたら粘らない() {
		// 書き方の誤りは、何度送っても同じ答えが返る
		assert_eq!(verdict_of(400), Verdict::Rejected);
		assert_eq!(verdict_of(403), Verdict::Rejected);
		assert_eq!(verdict_of(404), Verdict::Rejected);
		assert_eq!(verdict_of(500), Verdict::Rejected);
	}

	#[test]
	fn 繋ぎ直しの説明に合計の秒数を出す() {
		let c = Client {
			base: base(None, Some("8787")),
			access_token: None,
			retry_times: 6,
			retry_interval_sec: 10,
		};
		let text = c.describe_retry();
		assert!(text.contains("10 秒おき"), "{}", text);
		assert!(text.contains("6 回"), "{}", text);
		assert!(text.contains("60 秒"), "合計を出さないと、どれだけ待つか読めない: {}", text);
	}
}
