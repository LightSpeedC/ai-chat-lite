//! CLI の定義。
//!
//! 出どころは `src/client/options.mjs` である。`tools/20_build/export-options.mjs` が
//! JSON に書き出し、ここで `include_str!` して埋め込む。
//!
//! **手で写さない。**2 か所に書くと必ずずれる。実際に node 版と C# 版で
//! `usage()` の一覧が食い違い、`--retry-count` が抜けていたことがある。
//!
//! JSON は追跡しない（生成物）。`tools/20_build/build-aichat-rs.mjs` が
//! ビルドの前に作る。無いままだとコンパイルが通らないので、写し忘れには気づける。

use crate::json::{self, Json};

/// 読める JSON の版。`export-options.mjs` の `schema` と合わせる。
///
/// 形が変わったら、ここと `tests/cli-rs.test.mjs` の期待値も上げる。
/// 上げ忘れたまま動くと、古い形を新しい形として読んでしまう。
pub const EXPECTED_SCHEMA: i64 = 4;

const RAW: &str = include_str!("../cli-options.json");

#[derive(Debug, Clone)]
pub struct OptionDef {
	pub long: String,
	/// 短い形。持たないものもある
	pub short: Option<String>,
	/// 値の見出し。空なら旗（値を取らない）
	pub arg: String,
	/// そのコマンドだけのもの。`None` はどのコマンドにも付けられる
	pub cmd: Option<String>,
	pub desc: String,
}

impl OptionDef {
	/// 値を取らないか
	pub fn is_flag(&self) -> bool {
		self.arg.is_empty()
	}

	/// `--名前` と `-短い名前` を並べる
	pub fn flags(&self) -> Vec<String> {
		let mut out = vec![format!("--{}", self.long)];
		if let Some(s) = &self.short {
			out.push(format!("-{}", s));
		}
		out
	}
}

#[derive(Debug, Clone)]
pub struct CommandDef {
	pub name: String,
	pub arg: String,
	pub desc: String,
	/// サーバーに繋がないコマンド（`waiters`）
	pub offline: bool,
}

#[derive(Debug, Clone)]
pub struct RemovedDef {
	pub name: String,
	pub short: Option<String>,
	pub hint: String,
}

#[derive(Debug, Clone)]
pub struct WaitUnit {
	pub long: String,
	pub sec: i64,
}

#[derive(Debug, Clone)]
pub struct Definition {
	pub schema: i64,
	pub id_wrap: String,
	pub id_pattern: String,
	pub waiter_pattern: String,
	pub default_room: String,
	pub default_port: i64,
	pub max_wait_sec: i64,
	pub default_wait_sec: i64,
	pub retry_interval_sec: i64,
	pub retry_times: Vec<(String, i64)>,
	pub exit_unreachable: i64,
	pub wait_units: Vec<WaitUnit>,
	pub options: Vec<OptionDef>,
	pub commands: Vec<CommandDef>,
	pub admin_commands: Vec<CommandDef>,
	pub removed: Vec<RemovedDef>,
}

impl Definition {
	/// 埋め込んだ JSON を読む
	pub fn load() -> Result<Definition, String> {
		let root = json::parse(RAW).map_err(|e| format!("定義の JSON が読めません: {}", e))?;

		let schema = take_i64(&root, "schema")?;
		if schema != EXPECTED_SCHEMA {
			return Err(format!(
				"定義の形が違います（読めるのは {} ・ 渡されたのは {}）。\
				 export-options.mjs を走らせ直すか、EXPECTED_SCHEMA を合わせてください",
				EXPECTED_SCHEMA, schema
			));
		}

		let retry_times = match root.get("retry_times") {
			Some(Json::Obj(pairs)) => pairs
				.iter()
				.map(|(k, v)| (k.clone(), v.as_i64().unwrap_or(0)))
				.collect(),
			_ => return Err("retry_times がオブジェクトで入っていません".to_string()),
		};

		let wait_units = take_arr(&root, "wait_units")?
			.iter()
			.map(|u| {
				Ok(WaitUnit {
					long: take_str(u, "long")?,
					sec: take_i64(u, "sec")?,
				})
			})
			.collect::<Result<Vec<_>, String>>()?;

		let options = take_arr(&root, "options")?
			.iter()
			.map(|o| {
				Ok(OptionDef {
					long: take_str(o, "long")?,
					short: take_opt_str(o, "short"),
					arg: take_str(o, "arg")?,
					cmd: take_opt_str(o, "cmd"),
					desc: take_str(o, "desc")?,
				})
			})
			.collect::<Result<Vec<_>, String>>()?;

		let commands = take_commands(&root, "commands")?;
		let admin_commands = take_commands(&root, "admin_commands")?;

		let removed = take_arr(&root, "removed")?
			.iter()
			.map(|r| {
				Ok(RemovedDef {
					name: take_str(r, "name")?,
					short: take_opt_str(r, "short"),
					hint: take_str(r, "hint")?,
				})
			})
			.collect::<Result<Vec<_>, String>>()?;

		Ok(Definition {
			schema,
			id_wrap: take_str(&root, "id_wrap")?,
			id_pattern: take_str(&root, "id_pattern")?,
			waiter_pattern: take_str(&root, "waiter_pattern")?,
			default_room: take_str(&root, "default_room")?,
			default_port: take_i64(&root, "default_port")?,
			max_wait_sec: take_i64(&root, "max_wait_sec")?,
			default_wait_sec: take_i64(&root, "default_wait_sec")?,
			retry_interval_sec: take_i64(&root, "retry_interval_sec")?,
			retry_times,
			exit_unreachable: take_i64(&root, "exit_unreachable")?,
			wait_units,
			options,
			commands,
			admin_commands,
			removed,
		})
	}

	/// 長い名前からオプションの定義を引く
	pub fn option(&self, long: &str) -> Option<&OptionDef> {
		self.options.iter().find(|o| o.long == long)
	}

	/// 値を取らないオプションを、先頭の記号を含めて並べる（`positionals` に渡す）
	pub fn flag_words(&self) -> Vec<String> {
		self.options.iter().filter(|o| o.is_flag()).flat_map(|o| o.flags()).collect()
	}

	/// 名前からコマンドの定義を引く。管理コマンドも含める
	pub fn command(&self, name: &str) -> Option<&CommandDef> {
		self.commands
			.iter()
			.chain(self.admin_commands.iter())
			.find(|c| c.name == name)
	}

	/// そのコマンドが繋ぎ直す回数。定義に無ければ既定を使う
	pub fn retry_times(&self, command: &str) -> i64 {
		let find = |key: &str| self.retry_times.iter().find(|(k, _)| k == key).map(|(_, v)| *v);
		find(command).or_else(|| find("default")).unwrap_or(0)
	}
}

/// JSON から配列を取り出す
fn take_arr<'a>(obj: &'a Json, key: &str) -> Result<&'a [Json], String> {
	obj.get(key)
		.and_then(|v| v.as_arr())
		.ok_or_else(|| format!("{} が配列で入っていません", key))
}

/// コマンドの配列を読む。`offline` は無いこともある
fn take_commands(root: &Json, key: &str) -> Result<Vec<CommandDef>, String> {
	take_arr(root, key)?
		.iter()
		.map(|c| {
			Ok(CommandDef {
				name: take_str(c, "name")?,
				arg: take_str(c, "arg")?,
				desc: take_str(c, "desc")?,
				offline: c.get("offline").and_then(|v| v.as_bool()).unwrap_or(false),
			})
		})
		.collect()
}

/// JSON から文字列を取り出す。無ければ理由を返す
fn take_str(obj: &Json, key: &str) -> Result<String, String> {
	obj.get(key)
		.and_then(|v| v.as_str())
		.map(|s| s.to_string())
		.ok_or_else(|| format!("{} が文字列で入っていません", key))
}

/// JSON から整数を取り出す
fn take_i64(obj: &Json, key: &str) -> Result<i64, String> {
	obj.get(key)
		.and_then(|v| v.as_i64())
		.ok_or_else(|| format!("{} が整数で入っていません", key))
}

/// JSON から「文字列か null」を取り出す
fn take_opt_str(obj: &Json, key: &str) -> Option<String> {
	match obj.get(key) {
		Some(Json::Str(s)) => Some(s.clone()),
		_ => None,
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn 埋め込んだ定義を読める() {
		let def = Definition::load().expect("定義が読めません");
		assert_eq!(def.schema, EXPECTED_SCHEMA);
	}

	#[test]
	fn 接続先の既定値を持たない決めごとが数値として入っている() {
		// 既定のポートは定義に入っているが、使うのは使い方の表示だけ。
		// 繋ぐときは渡されなければ止める（options.mjs の決めごと）
		let def = Definition::load().unwrap();
		assert_eq!(def.default_port, 8787);
		assert_eq!(def.default_room, "public");
		assert_eq!(def.max_wait_sec, 240);
		assert_eq!(def.default_wait_sec, 12 * 3600);
		assert_eq!(def.exit_unreachable, 3);
		assert_eq!(def.retry_interval_sec, 10);
	}

	#[test]
	fn 名乗るIDの決まりが入っている() {
		let def = Definition::load().unwrap();
		assert_eq!(def.id_wrap, ":");
		assert!(def.id_pattern.starts_with('^'));
		assert!(def.waiter_pattern.contains("wait"));
	}

	#[test]
	fn コマンドが12件と管理2件ある() {
		let def = Definition::load().unwrap();
		assert_eq!(def.commands.len(), 12, "コマンドの数");
		assert_eq!(def.admin_commands.len(), 2, "管理コマンドの数");
	}

	#[test]
	fn オプションが22件ある() {
		let def = Definition::load().unwrap();
		assert_eq!(def.options.len(), 22);
	}

	#[test]
	fn 待受けはサーバーに繋がない印を持つ() {
		let def = Definition::load().unwrap();
		let waiters = def.command("waiters").expect("waiters がありません");
		assert!(waiters.offline, "waiters は繋がないコマンド");

		let wait = def.command("wait").expect("wait がありません");
		assert!(!wait.offline, "wait は繋ぐコマンド");
	}

	#[test]
	fn 管理コマンドも名前で引ける() {
		let def = Definition::load().unwrap();
		assert!(def.command("restart").is_some());
		assert!(def.command("stop").is_some());
		assert!(def.command("無いコマンド").is_none());
	}

	#[test]
	fn オプションを名前で引ける() {
		let def = Definition::load().unwrap();
		let port = def.option("port").expect("port がありません");
		assert_eq!(port.short.as_deref(), Some("p"));
		assert!(!port.is_flag(), "port は値を取る");
		assert_eq!(port.flags(), vec!["--port", "-p"]);

		let since = def.option("since").expect("since がありません");
		assert_eq!(since.short, None);
		assert_eq!(since.flags(), vec!["--since"]);
	}

	#[test]
	fn 旗だけを取り出せる() {
		let def = Definition::load().unwrap();
		let flags = def.flag_words();
		// 値を取らないものだけが入る
		assert!(flags.contains(&"--help".to_string()));
		assert!(flags.contains(&"-h".to_string()));
		assert!(flags.contains(&"--with-joins".to_string()));
		assert!(flags.contains(&"--with-messages".to_string()));
		// 値を取るものは入らない。入れると値が位置引数に混ざる
		assert!(!flags.contains(&"--port".to_string()));
		assert!(!flags.contains(&"--to".to_string()));
	}

	#[test]
	fn 繋ぎ直す回数はコマンドで変わる() {
		let def = Definition::load().unwrap();
		// wait はどうせ待つのが仕事なので長く粘る
		assert_eq!(def.retry_times("wait"), 60);
		// 止めに行くコマンドが繋がらない＝すでに止まっている
		assert_eq!(def.retry_times("restart"), 0);
		assert_eq!(def.retry_times("stop"), 0);
		// 人が打つものは 60 秒で諦める
		assert_eq!(def.retry_times("say"), 6);
		assert_eq!(def.retry_times("知らないコマンド"), 6);
	}

	#[test]
	fn 待つ長さの単位が3つある() {
		let def = Definition::load().unwrap();
		assert_eq!(def.wait_units.len(), 3);
		let hour = def.wait_units.iter().find(|u| u.long == "wait-hour").unwrap();
		assert_eq!(hour.sec, 3600);
	}

	#[test]
	fn 廃止したオプションが3件ある() {
		let def = Definition::load().unwrap();
		assert_eq!(def.removed.len(), 3);
		let c = def.removed.iter().find(|r| r.name == "connector-id").unwrap();
		assert_eq!(c.short.as_deref(), Some("c"));
		assert!(!c.hint.is_empty(), "直し方を書いていないと、渡した人が困る");
	}
}
