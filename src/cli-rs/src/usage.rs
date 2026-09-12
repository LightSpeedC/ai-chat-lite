//! 使い方の表示。
//!
//! **定義の表から組み立てる。**手で書くと、オプションを足したときに載り忘れる。
//! 実際に node 版で `--retry-count` が使い方から抜けていた。
//!
//! node 版の `usage()` と 1 文字ずつ同じにする。桁は表示幅で揃える
//! （日本語は半角 2 つ分）。

use crate::definition::{CommandDef, Definition, OptionDef};
use crate::width::{pad_end, width};

/// 説明を書き始める桁
const HELP_COLUMN: usize = 40;

/// 1 行分。左を桁まで詰めて説明を置く
fn help_line(indent: usize, left: &str, desc: &str) -> String {
	let head = format!("{}{}", " ".repeat(indent), left);
	let pad = HELP_COLUMN.saturating_sub(width(&head)).max(1);
	format!("{}{}{}", head, " ".repeat(pad), desc)
}

/// オプション 1 つを `--long <arg>  -s` の形にする
fn option_label(o: &OptionDef) -> String {
	let long = if o.arg.is_empty() {
		format!("--{}", o.long)
	} else {
		format!("--{} {}", o.long, o.arg)
	};
	match &o.short {
		Some(s) => format!("{}  -{}", long, s),
		None => long,
	}
}

/// コマンドと、そのコマンドだけのオプションを並べる
fn command_block(def: &Definition, list: &[CommandDef]) -> String {
	let mut lines = Vec::new();
	for c in list {
		let left = if c.arg.is_empty() {
			c.name.clone()
		} else {
			format!("{} {}", c.name, c.arg)
		};
		lines.push(help_line(2, &left, &c.desc));
		for o in def.options.iter().filter(|o| o.cmd.as_deref() == Some(c.name.as_str())) {
			lines.push(help_line(6, &option_label(o), &o.desc));
		}
	}
	lines.join("\n")
}

/// 使い方の全文を組み立てる。
///
/// * `base` … 決まっている接続先。無ければ渡し方の案内を出す
/// * `connector_id` … 名乗る ID。同上
pub fn render(def: &Definition, base: Option<&str>, connector_id: Option<&str>, room: &str) -> String {
	let globals: Vec<String> = def
		.options
		.iter()
		.filter(|o| o.cmd.is_none())
		.map(|o| help_line(2, &option_label(o), &o.desc))
		.collect();

	let base_line = match base {
		Some(b) => b.to_string(),
		None => format!("(未指定)  ← --port {} か --url <URL> を渡してください", def.default_port),
	};
	let id_line = match connector_id {
		Some(id) => id.to_string(),
		None => format!(
			"(未指定)  ← コマンドの直後に {}<自分のID>{} を置いてください",
			def.id_wrap, def.id_wrap
		),
	};

	format!(
		"ai-chat-lite クライアント\n\
		 \n\
		 \x20 接続先: {}\n\
		 \x20 名乗る ID: {}\n\
		 \x20 ルーム: {}         （--room で変更できる）\n\
		 \n\
		 コマンド:\n\
		 {}\n\
		 \n\
		 サーバーの操作（管理者権限は要らない）:\n\
		 {}\n\
		 \n\
		 どのコマンドにも付けられるもの:\n\
		 {}\n\n",
		base_line,
		id_line,
		room,
		command_block(def, &def.commands),
		command_block(def, &def.admin_commands),
		globals.join("\n")
	)
}

#[cfg(test)]
mod tests {
	use super::*;

	fn def() -> Definition {
		Definition::load().unwrap()
	}

	#[test]
	fn 説明は決まった桁から始まる() {
		let line = help_line(2, "--port <ポート>", "説明");
		// 2 + 15 = 17 桁ぶん使っているので、40 桁まで空ける
		assert_eq!(width(&line[..line.find("説明").unwrap()]), HELP_COLUMN);
	}

	#[test]
	fn 桁を超えていても1つは空ける() {
		let long = "a".repeat(60);
		let line = help_line(2, &long, "説明");
		assert!(line.contains(&format!("{} 説明", long)), "詰まっていない: {}", line);
	}

	#[test]
	fn 短い形があれば並べる() {
		let def = def();
		let port = def.option("port").unwrap();
		assert_eq!(option_label(port), "--port <ポート>  -p");
	}

	#[test]
	fn 値を取らないものは見出しを付けない() {
		let def = def();
		let joins = def.option("with-joins").unwrap();
		assert_eq!(option_label(joins), "--with-joins");
	}

	#[test]
	fn 接続先が無ければ渡し方を出す() {
		let text = render(&def(), None, None, "public");
		assert!(text.contains("(未指定)  ← --port 8787"), "{}", text);
		assert!(text.contains("コマンドの直後に :<自分のID>: を置いてください"), "{}", text);
	}

	#[test]
	fn 接続先があればそれを出す() {
		let text = render(&def(), Some("http://localhost:1234"), Some("me"), "public");
		assert!(text.contains("接続先: http://localhost:1234"), "{}", text);
		assert!(text.contains("名乗る ID: me"), "{}", text);
	}

	#[test]
	fn 全部のコマンドが載る() {
		let def = def();
		let text = render(&def, None, None, "public");
		for c in def.commands.iter().chain(def.admin_commands.iter()) {
			assert!(text.contains(&c.desc), "{} の説明が載っていない", c.name);
		}
	}

	#[test]
	fn 全部のオプションが載る() {
		// 手で書くと載り忘れる。実際に node 版で --retry-count が抜けていた
		let def = def();
		let text = render(&def, None, None, "public");
		for o in &def.options {
			assert!(text.contains(&format!("--{}", o.long)), "--{} が載っていない", o.long);
		}
	}

	#[test]
	fn 末尾に空行を1つ置く() {
		// node 版は console.log がもう 1 つ改行を足すので、そこまで含めて揃える
		let text = render(&def(), None, None, "public");
		assert!(text.ends_with("\n\n"), "末尾の空行が無いと 1 行ぶんずれる");
		assert!(!text.ends_with("\n\n\n"), "空行が多い");
	}

	#[test]
	fn コマンド専用のオプションはその下に付く() {
		let def = def();
		let text = render(&def, None, None, "public");
		let say_at = text.find("say :<id>:").expect("say が無い");
		let to_at = text.find("--to :<id>:").expect("--to が無い");
		let recent_at = text.find("recent ").expect("recent が無い");
		assert!(say_at < to_at && to_at < recent_at, "--to は say と recent の間に出る");
	}
}
