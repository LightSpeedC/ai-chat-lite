//! ai-chat-lite の CLI（Rust 版）。
//!
//! node 版（`src/client/chat.mjs`）・C# 版（`src/cli-cs/`）と同じ仕事をする。
//! 出力も終了コードも 1 文字ずつ揃える。食い違いは `tests/cli-rs.test.mjs` が落とす。
//!
//! 外部クレートを使わない。JSON も HTTP も標準ライブラリだけで書く。
//! 理由は計画書（notes/10_plan/p260913-01-CLIをRustで書く.html）にある。

mod json;

fn main() {
	// 段ごとに組み上げる。いまは土台だけ
	eprintln!("aichat-rs（作りかけ）");
	std::process::exit(2);
}
