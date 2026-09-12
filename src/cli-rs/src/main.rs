//! ai-chat-lite の CLI（Rust 版）。
//!
//! node 版（`src/client/chat.mjs`）・C# 版（`src/cli-cs/`）と同じ仕事をする。
//! 出力も終了コードも 1 文字ずつ揃える。食い違いは `tests/cli-rs.test.mjs` が落とす。
//!
//! 外部クレートを使わない。JSON も HTTP も標準ライブラリだけで書く。
//! 理由は計画書（notes/10_plan/p260913-01-CLIをRustで書く.html）にある。

mod args;
mod client;
mod commands;
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

	/*
	 * 接続先はここで要る。既定値を持たないので、無ければ止める。
	 * サーバーに繋がないコマンド（waiters）だけは先に振り分ける。
	 */
	let offline = def.command(command).map(|c| c.offline).unwrap_or(false);
	if offline {
		// waiters は名乗る ID が要る。サーバーには繋がない
		let me = match require_id(&def, &connector_id, &positionals) {
			Ok(id) => id,
			Err(code) => return code,
		};
		let basis = match basis_of(&def, &a, &base, &room) {
			Ok(b) => b,
			Err(code) => return code,
		};

		/*
		 * Windows で隣に C# 版があれば、数えるところから任せる。
		 *
		 * C# は .NET から WMI を直に叩けるが、こちらは PowerShell を起こすしかなく、
		 * その起動だけで 213 ms を使う。同じ答えを出すのに 2.5 倍かかる。
		 *
		 * **名乗る ID と接続先を確かめてから任せる。**先に任せると、書き忘れの
		 * 案内まで C# 版が出すことになり、node 版と出る順序が食い違う。
		 *
		 * 起こせなければ黙って自分で数える。任せられないことは失敗ではない。
		 */
		if let Some(target) = waiters::delegate_for_waiters(waiters::exe_dir().as_deref(), cfg!(windows)) {
			let passed: Vec<String> = std::env::args().skip(1).collect();
			if let Ok(status) = std::process::Command::new(&target).args(&passed).status() {
				return status.code().unwrap_or(1);
			}
		}

		return match commands::waiters_cmd(&me, &basis, &def.default_room) {
			Ok(()) => 0,
			Err(e) => {
				eprintln!("プロセスの一覧を取れませんでした。");
				eprintln!("  {}", e);
				1
			}
		};
	}

	let base = match base {
		Some(b) => b,
		None => {
			eprintln!("接続先が指定されていません。--port <ポート> か --url <URL> を渡してください。");
			eprintln!("  本番: --port {}", def.default_port);
			eprintln!("  テスト用: 置き場の server.json の port を使う");
			return EXIT_USAGE;
		}
	};

	let cli = client::Client {
		base,
		access_token: a.option("access-token", Some("a")).map(|s| s.to_string()),
		retry_times: def.retry_times(command),
		retry_interval_sec: def.retry_interval_sec,
	};

	/*
	 * 名乗る ID を先に確かめ、そのあとで環境を出す。順序は node 版に合わせる。
	 *
	 * 逆にすると、ID を書き忘れたときに「テスト（:NNNN）」が先に出る。
	 * 案内の頭に別の行が挟まると、読み手は何を直せばよいか探すことになる。
	 */
	const READ_ONLY: [&str; 4] = ["recent", "who", "dump", "archives"];
	let me = if READ_ONLY.contains(&command) {
		String::new()
	} else {
		match require_id(&def, &connector_id, &positionals) {
			Ok(id) => id,
			Err(code) => return code,
		}
	};

	// サーバーに繋ぐコマンドなら、どちらの環境かを出す
	commands::announce_env(&cli);

	let outcome = match command {
		"who" => commands::who(&cli),
		"recent" => {
			let opts = match recent_opts(&def, &a) {
				Ok(o) => o,
				Err(e) => {
					eprintln!("{}", e);
					return EXIT_USAGE;
				}
			};
			commands::recent(&cli, &room, &opts)
		}
		"say" => {
			// 名乗る ID を除いた次の位置引数が本文
			let body = positionals.get(1).copied().unwrap_or("");
			if body.is_empty() {
				eprintln!(
					"本文を指定してください: say {w}<自分のID>{w} \"本文\" [--to {w}<相手>{w}] [--reply-to <msg_seq>]",
					w = def.id_wrap
				);
				// 書き忘れは使い方の誤りなので 2
				return EXIT_USAGE;
			}
			let to = match a.option("to", None) {
				Some(raw) => match id::unwrap(raw, &def.id_wrap, "--to") {
					Ok(v) => Some(v),
					Err(e) => {
						eprintln!("{}", e);
						return EXIT_USAGE;
					}
				},
				None => None,
			};
			let reply_to = match reply_to_seq(&a) {
				Ok(v) => v,
				Err(e) => {
					eprintln!("{}", e);
					return EXIT_USAGE;
				}
			};
			commands::say(&cli, &me, &room, body, to.as_deref(), reply_to)
		}
		"join" => {
			commands::join(&cli, &me, &room, a.option("role", None).unwrap_or("ai"))
		}
		"leave" => {
			commands::leave(&cli, &me, &room)
		}
		"wait" => {
			let (limit_sec, from_default) = match wait_sec(&def, &a) {
				Ok(v) => v,
				Err(e) => {
					eprintln!("{}", e);
					return EXIT_USAGE;
				}
			};
			warn_if_foreground(limit_sec, from_default);
			let where_ = match a.option("port", Some("p")) {
				Some(p) => format!("-p {}", p),
				None => format!("-u {}", a.option("url", Some("u")).unwrap_or("")),
			};
			let opts = commands::WaitOpts {
				limit_sec,
				with_joins: a.has_flag("with-joins", None),
				max_wait_sec: def.max_wait_sec,
				// テスト用サーバーにはアクセストークンが要る。それを渡していれば試験中とみなす
				is_test: cli.access_token.is_some(),
				where_,
			};
			commands::wait(&cli, &me, &room, &opts)
		}
		"archive" => {
			let kind = positionals.get(1).copied().unwrap_or("");
			let raw_id = positionals.get(2).copied().unwrap_or("");
			if kind.is_empty() || raw_id.is_empty() {
				eprintln!("対象を指定してください: archive {w}<自分のID>{w} message|connector|room <対象>", w = def.id_wrap);
				return EXIT_USAGE;
			}
			if !["message", "connector", "room"].contains(&kind) {
				eprintln!("kind は message / connector / room です: {}", kind);
				return EXIT_USAGE;
			}
			// 参加者を片付けるときだけ、対象も参加者の ID なので囲みを剥がす
			let target = if kind == "connector" {
				match id::unwrap(raw_id, &def.id_wrap, "archive connector の対象") {
					Ok(v) => v,
					Err(e) => {
						eprintln!("{}", e);
						return EXIT_USAGE;
					}
				}
			} else {
				raw_id.to_string()
			};
			/*
			 * 既定のルームはサーバー側でも弾くが、ここでも先に弾く。
			 * 下見を出して名前まで打たせてから断るのは、手間をかけさせるだけになる。
			 */
			if kind == "room" && target == def.default_room {
				eprintln!("{} は片付けられません（参加時の行き先です）", def.default_room);
				return EXIT_USAGE;
			}
			match commands::archive(&cli, &me, kind, &target, a.has_flag("with-messages", None), a.option("description", None)) {
				Ok(0) => Ok(()),
				Ok(code) => return code,
				Err(e) => Err(e),
			}
		}
		"restore" => {
			let raw = positionals.get(1).copied().unwrap_or("");
			let ok = !raw.is_empty() && raw.bytes().all(|b| b.is_ascii_digit());
			if !ok {
				eprintln!("戻す番号を指定してください: restore {w}<自分のID>{w} <archived_seq>", w = def.id_wrap);
				return EXIT_USAGE;
			}
			commands::restore(&cli, &me, raw.parse().unwrap_or(0))
		}
		"rename" => {
			let kind = positionals.get(1).copied().unwrap_or("");
			let raw_from = positionals.get(2).copied().unwrap_or("");
			let raw_to = positionals.get(3).copied().unwrap_or("");
			if kind != "connector" || raw_from.is_empty() || raw_to.is_empty() {
				eprintln!("対象を指定してください: rename {w}<自分のID>{w} connector {w}<旧>{w} {w}<新>{w}", w = def.id_wrap);
				return EXIT_USAGE;
			}
			let from = match id::unwrap(raw_from, &def.id_wrap, "rename の旧 ID") {
				Ok(v) => v,
				Err(e) => { eprintln!("{}", e); return EXIT_USAGE; }
			};
			let to = match id::unwrap(raw_to, &def.id_wrap, "rename の新しい ID") {
				Ok(v) => v,
				Err(e) => { eprintln!("{}", e); return EXIT_USAGE; }
			};
			if from == to {
				eprintln!("同じ ID には付け替えられません: {}", from);
				return EXIT_USAGE;
			}
			match commands::rename(&cli, &me, &from, &to) {
				Ok(0) => Ok(()),
				Ok(code) => return code,
				Err(e) => Err(e),
			}
		}
		// 落とす。1 は異常終了として扱われ 10 秒後に起動し直す。0 は止まったまま
		"restart" => commands::exit_server(&cli, &me, 1),
		"stop" => commands::exit_server(&cli, &me, 0),
		"archives" => commands::archives(&cli),
		"dump" => {
			// 既定は tmp/messages.jsonl。ROOT からの相対で決める
			let out = match a.option("out", None) {
				Some(p) => std::path::PathBuf::from(p),
				None => std::env::current_dir().unwrap_or_default().join("tmp").join("messages.jsonl"),
			};
			commands::dump(&cli, &out)
		}
		_ => {
			eprintln!("{} はまだ作っていません（Rust 版）", command);
			return EXIT_USAGE;
		}
	};

	match outcome {
		Ok(()) => 0,
		Err(client::CallError::Rejected { status, error, detail }) => {
			eprintln!("エラー ({}): {}", status, error);
			if let Some(d) = detail {
				eprintln!("  {}", d);
			}
			1
		}
		Err(client::CallError::Unreachable { reason }) => {
			eprintln!("諦めました: {}", reason);
			if cli.retry_times > 0 {
				eprintln!("  {}繋がりませんでした", cli.describe_retry());
			}
			eprintln!("  サービスが動いているか確認してください");
			eprintln!("  例: node-ai-chat-lite-winsw.exe status");
			def.exit_unreachable as i32
		}
	}
}

/// `recent` の絞り込みを引数から組み立てる。
///
/// 期間の起点は 1 つだけにする。複数あると、どれが効いているか読めない。
fn recent_opts(def: &Definition, a: &Args) -> Result<commands::RecentOpts, String> {
	const MS_PER_DAY: i64 = 24 * 60 * 60 * 1000;
	const MS_PER_HOUR: i64 = 60 * 60 * 1000;

	// 起点は --since / --since-day / --since-hour の 3 通り
	let given: Vec<(&str, &str)> = [("since", "since"), ("since-day", "since-day"), ("since-hour", "since-hour")]
		.iter()
		.filter_map(|(long, _)| a.option(long, None).map(|v| (*long, v)))
		.collect();

	if given.len() > 1 {
		let names: Vec<String> = given.iter().map(|(l, _)| format!("--{}", l)).collect();
		return Err(format!(
			"期間の起点は 1 つだけ指定してください: {} が両方あります。",
			names.join(" と ")
		));
	}

	let since = match given.first() {
		None => None,
		Some(("since", raw)) => Some(since::resolve(raw, None).map_err(|e| e.to_string())?),
		Some((long, raw)) => {
			if raw.is_empty() || !raw.bytes().all(|b| b.is_ascii_digit()) {
				return Err(format!("--{} には 0 以上の数だけを渡してください: {}", long, raw));
			}
			let n: i64 = raw.parse().map_err(|_| format!("--{} には 0 以上の数だけを渡してください: {}", long, raw))?;
			let unit = if *long == "since-day" { MS_PER_DAY } else { MS_PER_HOUR };
			Some(jst::before(n * unit))
		}
	};

	// --before は --since が決めた値を引き継ぐ。独立に丸めると範囲が壊れる
	let before = match a.option("before", None) {
		Some(raw) => Some(since::resolve(raw, since.as_deref()).map_err(|e| e.to_string())?),
		None => None,
	};

	let find = a.option("find", None).map(|s| s.to_string());
	let from = match a.option("from", None) {
		Some(raw) => Some(id::unwrap_flexible(raw, &def.id_wrap, "--from")?),
		None => None,
	};

	let has_filter = since.is_some() || before.is_some() || find.is_some() || from.is_some();

	/*
	 * 絞り込みを指定したときは既定の上限を 500 にする。-n を明示すればそちらが勝つ。
	 *
	 * 期間や検索で自然に絞られているのに、既定の 20 件で黙って古い方が
	 * 切り捨てられると気づきにくい。
	 */
	let limit = match a.option("n", Some("n")) {
		Some(raw) => raw.parse::<i64>().ok().filter(|n| *n != 0).unwrap_or(20),
		None if has_filter => 500,
		None => 20,
	};

	Ok(commands::RecentOpts { limit, since, before, find, from, has_filter })
}

/// 名乗る ID を要る形で取り出す。無ければ案内を出して終了コードを返す。
///
/// **読むだけのコマンド（recent ・ who ・ dump ・ archives）は名乗らなくてよい。**
/// ここを呼ぶのは書き込み系だけにする。
fn require_id(def: &Definition, resolved: &Option<String>, positionals: &[&str]) -> Result<String, i32> {
	if let Some(id) = resolved {
		return Ok(id.clone());
	}

	let command = std::env::args().nth(1).unwrap_or_default();

	match positionals.first() {
		// 置かれてはいるが、囲みか文字が違う。unwrap の言葉をそのまま出す
		Some(raw) => {
			let where_ = format!("{} の直後", command);
			match id::unwrap(raw, &def.id_wrap, &where_) {
				Ok(id) => Ok(id),
				Err(e) => {
					eprintln!("{}", e);
					Err(2)
				}
			}
		}
		None => {
			// 自分の project フォルダ名を見本に出す
			let here = std::env::current_dir()
				.ok()
				.and_then(|p| p.file_name().map(|s| s.to_string_lossy().into_owned()))
				.unwrap_or_else(|| "project".to_string());

			eprintln!("名乗る ID が指定されていません。");
			eprintln!();
			eprintln!("  {} の直後に、コロンで囲んで置いてください:", command);
			eprintln!("    {} {}{}{}", command, def.id_wrap, here, def.id_wrap);
			eprintln!();
			eprintln!("  自分の project フォルダ名にしておくと、誰の発言か分かりやすくなります。");
			// 2 = 使い方の誤り。囲みの誤り・本文の不足・接続先の不足と揃える
			Err(2)
		}
	}
}

/// `--reply-to` を読む。先頭の # は付けても付けなくてもよい
fn reply_to_seq(a: &Args) -> Result<Option<i64>, String> {
	let raw = match a.option("reply-to", None) {
		Some(v) => v,
		None => return Ok(None),
	};
	let value = raw.strip_prefix('#').unwrap_or(raw);
	let ok = !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit());
	let num = if ok { value.parse::<i64>().unwrap_or(0) } else { 0 };
	if !ok || num < 1 {
		return Err(format!(
			"--reply-to には 1 以上の数を渡してください: {}\n  番号は出力の先頭に #474 の形で出ています。",
			raw
		));
	}
	Ok(Some(num))
}

/// 最大どれだけ待つかを秒で返す。0 は上限なし。
///
/// 単位ごとに別のオプションを持つ。値だけを見て取り違えないようにするため
/// （`--wait 480` が分か秒かは定義を読まないと分からない）。3 つは排他。
fn wait_sec(def: &Definition, a: &Args) -> Result<(i64, bool), String> {
	let given: Vec<(&str, &str, i64)> = def
		.wait_units
		.iter()
		.filter_map(|u| a.option(&u.long, if u.long == "wait-hour" { Some("w") } else { None })
			.map(|raw| (u.long.as_str(), raw, u.sec)))
		.collect();

	if given.len() > 1 {
		let names: Vec<String> = given.iter().map(|(l, _, _)| format!("--{}", l)).collect();
		return Err(format!(
			"待つ長さは 1 つだけ指定してください: {} が両方あります。",
			names.join(" と ")
		));
	}
	if given.is_empty() {
		return Ok((def.default_wait_sec, true));
	}

	let (long, raw, unit) = given[0];
	if raw.is_empty() || !raw.bytes().all(|b| b.is_ascii_digit()) {
		return Err(format!("--{} には 0 以上の数だけを渡してください: {}", long, raw));
	}
	let n: i64 = raw.parse().map_err(|_| format!("--{} には 0 以上の数だけを渡してください: {}", long, raw))?;
	Ok((n * unit, false))
}

/// 前面で長く待つ設定なら、背面で呼ぶよう案内する。
///
/// 打ち切られるのではない。プロセスはそのまま走り続けるが、それまで
/// 呼び出し側が待たされる。
fn warn_if_foreground(limit_sec: i64, from_default: bool) {
	if !commands::should_warn_foreground(limit_sec, from_default) {
		return;
	}
	let label = commands::describe_wait(limit_sec);
	// 括弧は「11 分」を秒に直して見せるためのもの。--wait-sec なら同じ値が 2 度出る
	let detail = if label == format!("{} 秒", limit_sec) {
		label
	} else {
		format!("{}（{} 秒）", label, limit_sec)
	};
	eprintln!("{}待つ設定です。", detail);
	eprintln!("  前面で呼ぶと {} 秒で背面に移されます。プロセスは走り続けますが、", commands::FOREGROUND_SEC);
	eprintln!("  それまでの間、呼び出し側は待たされます。");
	eprintln!("  はじめから run_in_background で呼んでください。");
	eprintln!();
}

/// どこを見ている待受けを数えるかを決める。
///
/// **接続先を省略できない。既定値を持たない。**他のコマンドと同じ扱いにする。
/// 既定を本番にすると、テストのつもりで数えたものが本番の本数として返る。
/// 「張っているから張らない」と判断して本番の待受けが 1 本も無いまま止まる。
/// 書き込まないだけで、事故の形は同じ。
fn basis_of(def: &Definition, a: &Args, base: &Option<client::Base>, room: &str) -> Result<commands::Basis, i32> {
	let b = match base {
		Some(b) => b,
		None => {
			eprintln!("どこを見ている待受けを数えるかが指定されていません。");
			eprintln!();
			eprintln!(
				"  本番: waiters {w}<自分のID>{w} -p {} -r {}",
				def.default_port,
				def.default_room,
				w = def.id_wrap
			);
			eprintln!();
			eprintln!("  既定値は持ちません。テストのつもりで数えた本数を本番の本数と読み違えるのを防ぐためです。");
			return Err(2);
		}
	};

	let where_ = match a.option("port", Some("p")) {
		Some(p) => format!("-p {}", p),
		None => format!("-u {}", a.option("url", Some("u")).unwrap_or("")),
	};

	// 案内に出す形は、ポートで渡したときだけ :ポート にする
	let label = if a.option("port", Some("p")).is_some() {
		format!(":{}", b.port)
	} else {
		commands::describe_place(&b.display)
	};

	Ok(commands::Basis {
		label,
		port: b.port as i64,
		rooms: waiters::rooms_from(Some(room), &def.default_room),
		where_,
	})
}
