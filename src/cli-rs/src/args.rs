//! コマンドラインの読み取り。
//!
//! node 版（`chat.mjs` の `option` ・ `hasFlag` ・ `positionals`）と同じ読み方をする。
//! 定義そのものは持たない。`--名前` と `-短い名前` を渡してもらい、探すだけにする。
//! そうすると、定義を読み込まずに単体で確かめられる。
//!
//! 並びは `<コマンド> [位置引数...] [オプション...]` を想定するが、**順序は問わない**。
//! オプションが先に来ても位置引数は拾える。

pub struct Args {
	/// プログラム名を除いた全部。旗と廃止したオプションはここから探す
	words: Vec<String>,
	/// 最初の語。コマンド名
	command: Option<String>,
	/// コマンド名を除いた残り。値付きオプションと位置引数はここから探す
	rest: Vec<String>,
}

impl Args {
	/// `std::env::args()` の結果（プログラム名を含む）から作る
	pub fn from_argv<I: IntoIterator<Item = String>>(argv: I) -> Args {
		let words: Vec<String> = argv.into_iter().skip(1).collect();
		let command = words.first().cloned();
		let rest = words.iter().skip(1).cloned().collect();
		Args { words, command, rest }
	}

	/// コマンド名。何も渡されていなければ `None`
	pub fn command(&self) -> Option<&str> {
		self.command.as_deref()
	}

	/// `--名前 値` の形で渡された値。短い形も同じ値として受ける。
	///
	/// **長い形を先に見る。**両方書かれたときは長い形が勝つ。
	pub fn option(&self, long: &str, short: Option<&str>) -> Option<&str> {
		let long_flag = format!("--{}", long);
		let short_flag = short.map(|s| format!("-{}", s));

		// 長い形を先に。見つからなければ短い形
		for flag in std::iter::once(&long_flag).chain(short_flag.iter()) {
			if let Some(i) = self.rest.iter().position(|w| w == flag) {
				if let Some(value) = self.rest.get(i + 1) {
					return Some(value);
				}
			}
		}
		None
	}

	/// 値を取らないオプションが渡されたか。
	///
	/// コマンドの位置に置かれることがある（`aichat -h`）ので、`rest` ではなく全体を見る。
	pub fn has_flag(&self, long: &str, short: Option<&str>) -> bool {
		let long_flag = format!("--{}", long);
		if self.words.iter().any(|w| *w == long_flag) {
			return true;
		}
		match short {
			Some(s) => {
				let short_flag = format!("-{}", s);
				self.words.iter().any(|w| *w == short_flag)
			}
			None => false,
		}
	}

	/// オプションでない語を、渡された順に返す。
	///
	/// `flags` には値を取らないオプション（`--help` ・ `-h` など）を、
	/// 先頭の記号を含めて渡す。**旗は次の語を飛ばさない。**飛ばすと
	/// `archive room sandbox` の `sandbox` が消える。
	pub fn positionals(&self, flags: &[String]) -> Vec<&str> {
		let mut out = Vec::new();
		let mut i = 0;
		while i < self.rest.len() {
			let word = &self.rest[i];
			if word.starts_with('-') {
				// 旗でなければ次の語が値。飛ばす
				if !flags.iter().any(|f| f == word) {
					i += 1;
				}
				i += 1;
				continue;
			}
			out.push(word.as_str());
			i += 1;
		}
		out
	}

	/// 渡された語の全体（廃止したオプションを探すのに使う）
	pub fn words(&self) -> &[String] {
		&self.words
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	/// テスト用。プログラム名を先頭に足して `Args` を作る
	fn args(items: &[&str]) -> Args {
		let mut all = vec!["aichat-rs".to_string()];
		all.extend(items.iter().map(|s| s.to_string()));
		Args::from_argv(all)
	}

	/// 値を取らないオプションの一覧（テスト用の見本）
	fn flags() -> Vec<String> {
		["--help", "-h", "--with-joins", "--with-messages"]
			.iter()
			.map(|s| s.to_string())
			.collect()
	}

	#[test]
	fn 最初の語がコマンドになる() {
		assert_eq!(args(&["wait", ":me:"]).command(), Some("wait"));
		assert_eq!(args(&[]).command(), None);
	}

	#[test]
	fn 長い形で値を取れる() {
		let a = args(&["say", ":me:", "本文", "--port", "8787"]);
		assert_eq!(a.option("port", Some("p")), Some("8787"));
	}

	#[test]
	fn 短い形で値を取れる() {
		let a = args(&["say", ":me:", "本文", "-p", "8787"]);
		assert_eq!(a.option("port", Some("p")), Some("8787"));
	}

	#[test]
	fn 両方あれば長い形が勝つ() {
		// 黙って片方を優先すると、書いたつもりの側が効かずに気づけない
		let a = args(&["who", "-p", "1111", "--port", "2222"]);
		assert_eq!(a.option("port", Some("p")), Some("2222"));
	}

	#[test]
	fn 値が続いていなければ取れない() {
		let a = args(&["who", "--port"]);
		assert_eq!(a.option("port", Some("p")), None);
	}

	#[test]
	fn 短い形を持たないオプションは長い形だけ見る() {
		let a = args(&["recent", "--since", "2026/09/13"]);
		assert_eq!(a.option("since", None), Some("2026/09/13"));
		assert_eq!(a.option("find", None), None);
	}

	#[test]
	fn コマンドの位置にある旗も見つける() {
		// aichat -h のように、旗だけを渡すとコマンドの位置に入る
		assert!(args(&["-h"]).has_flag("help", Some("h")));
		assert!(args(&["--help"]).has_flag("help", Some("h")));
		assert!(args(&["wait", ":me:", "--help"]).has_flag("help", Some("h")));
		assert!(!args(&["wait", ":me:"]).has_flag("help", Some("h")));
	}

	#[test]
	fn 位置引数はコマンドを含まない() {
		let a = args(&["say", ":me:", "本文"]);
		assert_eq!(a.positionals(&flags()), vec![":me:", "本文"]);
	}

	#[test]
	fn 値付きオプションの値は位置引数に混ざらない() {
		let a = args(&["say", ":me:", "本文", "--port", "8787", "--to", ":you:"]);
		assert_eq!(a.positionals(&flags()), vec![":me:", "本文"]);
	}

	#[test]
	fn 旗は次の語を飛ばさない() {
		// 飛ばすと archive room sandbox の sandbox が消える
		let a = args(&["archive", ":me:", "--with-messages", "room", "sandbox"]);
		assert_eq!(a.positionals(&flags()), vec![":me:", "room", "sandbox"]);
	}

	#[test]
	fn オプションが先に来ても位置引数を拾える() {
		let a = args(&["say", "--port", "8787", ":me:", "本文"]);
		assert_eq!(a.positionals(&flags()), vec![":me:", "本文"]);
	}

	#[test]
	fn 負の数を渡しても値として読む() {
		// -1 は短い形のオプションに見えるが、値の位置にあるものは値として扱う
		let a = args(&["recent", "--since-day", "-1"]);
		assert_eq!(a.option("since-day", None), Some("-1"));
	}

	#[test]
	fn 全体の語を取り出せる() {
		// 廃止したオプションは、コマンドの位置にあっても捕まえたい
		let a = args(&["-c", "me", "wait"]);
		assert_eq!(a.words(), &["-c".to_string(), "me".to_string(), "wait".to_string()]);
	}
}
