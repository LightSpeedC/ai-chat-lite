//! ai-chat-lite の CLI（Rust 版）。
//!
//! node 版（`src/client/chat.mjs`）・C# 版（`src/cli-cs/`）と同じ仕事をする。
//! 出力も終了コードも 1 文字ずつ揃える。食い違いは `tests/cli-rs.test.mjs` が落とす。
//!
//! 外部クレートを使わない。JSON も HTTP も標準ライブラリだけで書く。
//! 理由は計画書（notes/10_plan/p260913-01-CLIをRustで書く.html）にある。

mod args;
mod client;
mod definition;
mod http;
mod id;
mod json;
mod jst;
mod since;
mod usage;
mod waiters;
mod width;

use args::Args;
use definition::Definition;

/// 終了コード。
///
///   1 … 一般のエラー
///   2 … 使い方の誤り
///   3 … 繋がらない（サーバーの都合。定義の exit_unreachable）
///
/// 3 を分けているのは、呼ぶ側が「自分の書き方が悪い」のか「向こうが止まっている」
/// のかを区別できるようにするため。
const EXIT_USAGE: i32 = 2;

fn main() {
	std::process::exit(run());
}

fn run() -> i32 {
	let def = match Definition::load() {
		Ok(d) => d,
		Err(e) => {
			// 埋め込んだ定義が読めないのは作り方の誤り。使う人にはどうにもできない
			eprintln!("CLI の定義が読めません: {}", e);
			eprintln!("  tools/20_build/build-aichat-rs.mjs で作り直してください");
			return 1;
		}
	};

	let a = Args::from_argv(std::env::args());

	// 廃止したオプションは、コマンドの位置にあっても捕まえる
	for r in &def.removed {
		let long = format!("--{}", r.name);
		let short = r.short.as_ref().map(|s| format!("-{}", s));
		let given = a
			.words()
			.iter()
			.find(|w| **w == long || short.as_ref().map(|s| *w == s).unwrap_or(false));
		if let Some(g) = given {
			eprintln!("{} は廃止されました。", g);
			eprintln!("  {}", r.hint);
			return EXIT_USAGE;
		}
	}

	let base = match client::resolve_base(a.option("url", Some("u")), a.option("port", Some("p"))) {
		Ok(b) => b,
		Err(e) => {
			eprintln!("{}", e);
			return EXIT_USAGE;
		}
	};

	let room = a.option("room", Some("r")).unwrap_or(&def.default_room).to_string();

	// 名乗る ID はコマンドの直後の位置引数に置く
	let positionals = a.positionals(&def.flag_words());
	let connector_id = positionals
		.first()
		.and_then(|raw| id::unwrap(raw, &def.id_wrap, "コマンドの直後").ok());

	/*
	 * 使い方を出して終わるのは 3 通り。
	 *   コマンドを付けない / -h・--help を付ける / 知らないコマンドを渡す
	 *
	 * 知らないコマンドだけ終了コード 1 にする。書き間違いに気づけるようにするため。
	 */
	let wants_help = a.has_flag("help", Some("h"));
	let command = a.command().unwrap_or("");
	let known = def.command(command).is_some();

	if wants_help || !known {
		print!(
			"{}",
			usage::render(
				&def,
				base.as_ref().map(|b| b.display.as_str()),
				connector_id.as_deref(),
				&room
			)
		);
		return if !wants_help && !command.is_empty() { 1 } else { 0 };
	}

	// ここから先は段 3 以降で埋める
	eprintln!("{} はまだ作っていません（Rust 版）", command);
	EXIT_USAGE
}
