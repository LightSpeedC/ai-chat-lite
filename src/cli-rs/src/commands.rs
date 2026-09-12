//! 各コマンドの中身。
//!
//! 出力は node 版と 1 文字ずつ同じにする。桁は表示幅で揃える（日本語は半角 2 つ分）。

use crate::client::{CallError, Client};
use crate::json::Json;
use crate::jst;

/// 新着を待つときの設定
pub struct WaitOpts {
	/// 最大どれだけ待つか（秒）。0 は上限なし
	pub limit_sec: i64,
	/// 参加・離脱でも起こすか
	pub with_joins: bool,
	/// 1 回の long-poll の上限（定義の max_wait_sec）
	pub max_wait_sec: i64,
	/// テスト用として動いているか。記録を残すかの判断に使う
	pub is_test: bool,
	/// 初めての接続のときに見本へ出す接続先（`-p 8787` の形）
	pub where_: String,
}

/// 新着を待つ。
///
/// **1 回の long-poll は 240 秒で必ず返る。**サーバー側で引き延ばすと、途中の
/// 切断に気づけないまま握り続けることになる。代わりに、返ってきたら黙って
/// 張り直す。何回に分かれたかは呼ぶ側に関係がないので出さない。
pub fn wait(client: &Client, id: &str, room: &str, opts: &WaitOpts) -> Result<(), CallError> {
	let unlimited = opts.limit_sec == 0;
	let label = describe_wait(opts.limit_sec);

	/*
	 * 参加・離脱では起こさない。
	 *
	 * public には join と leave が数分ごとに流れるため、既定のままだと 12 時間を
	 * 指定しても数分で返っていた。絞るのはサーバー側にする。ここで捨てて待ち直すと、
	 * 待った秒数の数え方が「待ち切った」前提のままになり、実際の経過より速く上限に達する。
	 */
	let exclude = if opts.with_joins { "" } else { "&exclude=join,leave" };

	/*
	 * 初めての接続なら案内を出して終わる（課題 i260909-01）。
	 *
	 * wait は背面に張る運用が前提で、完了時にしか通知が来ない。案内を出しても
	 * そのまま 12 時間待ち続けると、案内そのものが誰の目にも触れない。
	 */
	let status = client.call(
		"GET",
		&format!(
			"/api/cursor-status?connector_id={}&room_id={}",
			encode_query(id),
			encode_query(room)
		),
		None,
		None,
	)?;

	if status.get("first_time").and_then(|v| v.as_bool()).unwrap_or(false) {
		let empty: Vec<Json> = Vec::new();
		let rooms = status.get("rooms").and_then(|v| v.as_arr()).unwrap_or(&empty);
		// 初めてなのは、指定したルームのうち一部だけのことがある
		let first: Vec<&str> = rooms
			.iter()
			.filter(|r| r.get("first_time").and_then(|v| v.as_bool()).unwrap_or(false))
			.filter_map(|r| r.get("room_id").and_then(|v| v.as_str()))
			.collect();

		println!(
			"初めての接続です（{}）。参加より前の発言は待ちません。過去が必要なら recent で取ってください（例）:",
			first.join(", ")
		);
		/*
		 * 見本には -r を必ず付ける。recent の既定は public なので、付けずに
		 * 写されると「初めてだと言ったルーム」ではなく public を見ることになり、
		 * 取れると言われた過去が出てこない。recent は 1 ルームずつなので、
		 * ルームごとに見本を出す。
		 */
		for r in &first {
			println!(
				"    aichat recent --find \"ルール\" {} -r {}   # {} のルール変更の周知をまとめて見る",
				opts.where_, r, r
			);
			println!("    aichat recent --since-day 1 {} -r {}     # {} の 1 日前からの発言を見る", opts.where_, r, r);
		}
		println!();

		/*
		 * 対象は初めてのルームだけに絞る。全体に対して呼ぶと、既存カーソルを持つ
		 * ルームの未読まで取得したうえで画面に出さず、カーソルだけ最新に進めてしまう。
		 * 取りこぼしではなく「表示せずに既読化する」形のデータ消失になる（i260909-03）。
		 */
		client.call(
			"GET",
			&format!(
				"/api/poll?connector_id={}&room_id={}&wait=0",
				encode_query(id),
				encode_query(&first.join(","))
			),
			None,
			None,
		)?;
		println!("カーソルを立てました。改めて wait を実行してください。");
		return Ok(());
	}

	/*
	 * 出すのは 2 行だけ。12 時間を 240 秒ごとに知らせると 180 行になる。
	 *
	 * 「待受け中」と進行形にしてあるのは、この 1 行だけを見た相手に「終わった」と
	 * 読ませないため。待受けを張るサブエージェントは背面のコマンドを起こした時点で
	 * 自分の仕事を終えるので、親には「終了」の扱いで通知が届く（課題 i260905-01）。
	 *
	 * pid を添えるのは、走っているかを親が確かめられるようにするため。
	 */
	let pid = std::process::id();
	println!(
		"pid {} で待受け中（最大 {}、ルーム {}、{}{}）",
		pid,
		label,
		room,
		id,
		if opts.with_joins { "、参加・離脱も" } else { "" }
	);

	let root = std::env::current_dir().unwrap_or_default();
	let log = WaitLog::open(&root, id, opts.is_test);
	log.write(
		"INFO",
		&format!(
			"待受け開始（最大 {}、ルーム {}、{}、pid {}{}）",
			label,
			room,
			id,
			pid,
			if opts.with_joins { "、参加・離脱も" } else { "、参加・離脱は除く" }
		),
	);

	let mut waited = 0i64;
	let mut last: Option<Json> = None;

	while unlimited || waited < opts.limit_sec {
		let this = if unlimited {
			opts.max_wait_sec
		} else {
			opts.max_wait_sec.min(opts.limit_sec - waited)
		};

		/*
		 * since は渡さない。どこまで読んだかはサーバーが覚えている。
		 * 受け取った分は返答と同時に記録されるので、次はその続きから届く。
		 */
		let result = client.call(
			"GET",
			&format!(
				"/api/poll?connector_id={}&room_id={}&wait={}{}",
				encode_query(id),
				encode_query(room),
				this,
				exclude
			),
			None,
			// 待つ長さより十分に長く取る。ここで切ると待受けが途中で落ちる
			Some(std::time::Duration::from_secs((this + 60) as u64)),
		)?;
		waited += this;

		let empty: Vec<Json> = Vec::new();
		let messages = result.get("messages").and_then(|v| v.as_arr()).unwrap_or(&empty).to_vec();

		log.write(
			"INFO",
			&format!(
				"待機中（経過 {} 秒 / 上限 {}、新着 {} 件、現在位置 {}）",
				waited,
				if unlimited { "無し".to_string() } else { format!("{} 秒", opts.limit_sec) },
				messages.len(),
				describe_positions(&result)
			),
		);

		if !messages.is_empty() {
			println!("新着 {} 件:", messages.len());
			print_messages(&messages);
			log.write("INFO", &format!("新着 {} 件を受け取って終わります", messages.len()));
			return Ok(());
		}
		last = Some(result);
	}

	let positions = last.as_ref().map(describe_positions).unwrap_or_else(|| "0".to_string());
	println!("新着なし（{}待機、現在位置 {}）", label, positions);
	log.write("INFO", &format!("新着なし。上限まで待ち切って終わります（{}）", label));
	Ok(())
}

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

/// 投稿する
pub fn say(
	client: &Client,
	from: &str,
	room: &str,
	body: &str,
	to: Option<&str>,
	reply_to: Option<i64>,
) -> Result<(), CallError> {
	let mut fields = vec![
		("from_connector_id".to_string(), Json::Str(from.to_string())),
		("room_id".to_string(), Json::Str(room.to_string())),
		(
			"to_connector_id".to_string(),
			match to {
				Some(id) => Json::Str(id.to_string()),
				None => Json::Null,
			},
		),
		(
			"reply_to_msg_seq".to_string(),
			match reply_to {
				Some(n) => Json::Num(n as f64),
				None => Json::Null,
			},
		),
	];
	fields.push(("msg_body".to_string(), Json::Str(body.to_string())));

	let message = client.call("POST", "/api/say", Some(&Json::Obj(fields).to_string()), None)?;
	println!(
		"送信しました（{}）",
		message.get("msg_seq").and_then(|v| v.as_i64()).unwrap_or(0)
	);
	Ok(())
}

/// 参加登録する
pub fn join(client: &Client, id: &str, room: &str, role: &str) -> Result<(), CallError> {
	let body = Json::Obj(vec![
		("connector_id".to_string(), Json::Str(id.to_string())),
		("connector_role".to_string(), Json::Str(role.to_string())),
		("room_id".to_string(), Json::Str(room.to_string())),
	]);
	let result = client.call("POST", "/api/join", Some(&body.to_string()), None)?;

	let empty: Vec<Json> = Vec::new();
	let connectors = result.get("connectors").and_then(|v| v.as_arr()).unwrap_or(&empty);
	println!(
		"{} として {} に参加しました（現在位置 {}）",
		id,
		result.get("room_id").and_then(|v| v.as_str()).unwrap_or(room),
		result.get("msg_seq").and_then(|v| v.as_i64()).unwrap_or(0)
	);
	println!("参加者 {} 人:", connectors.len());
	for c in connectors {
		let get = |key: &str| c.get(key).and_then(|v| v.as_str()).unwrap_or("");
		println!("  {} {} ({})", status_mark(get("status")), get("connector_id"), get("status_label"));
	}
	Ok(())
}

/// 離脱を知らせる
pub fn leave(client: &Client, id: &str, room: &str) -> Result<(), CallError> {
	let body = Json::Obj(vec![
		("connector_id".to_string(), Json::Str(id.to_string())),
		("room_id".to_string(), Json::Str(room.to_string())),
	]);
	client.call("POST", "/api/leave", Some(&body.to_string()), None)?;
	println!("{} として離脱しました", id);
	Ok(())
}

/// 待つ長さを人が読む形にする。0 は上限なし
pub fn describe_wait(sec: i64) -> String {
	if sec == 0 {
		return "上限なし".to_string();
	}
	if sec % 3600 == 0 {
		return format!("{} 時間", sec / 3600);
	}
	if sec % 60 == 0 {
		return format!("{} 分", sec / 60);
	}
	format!("{} 秒", sec)
}

/// 前面のツール実行が背面に移されるまでの秒数
pub const FOREGROUND_SEC: i64 = 600;

/// 前面で長く待つ設定かどうか。
///
/// 打ち切られるのではない。プロセスはそのまま走り続けるが、それまで
/// 呼び出し側が待たされる。**既定のままなら出さない。**既定は 12 時間なので、
/// 毎回出ることになって案内の意味がなくなる。
pub fn should_warn_foreground(limit_sec: i64, from_default: bool) -> bool {
	!from_default && limit_sec != 0 && limit_sec > FOREGROUND_SEC
}

/// どこまで読んだかを 1 行にする。
///
/// 位置はルームごとに持っている。1 つだけなら数を、複数なら「ルーム 数」を並べる。
/// 複数のときに 1 つの数で出すと、どのルームの位置か分からない。
pub fn describe_positions(result: &Json) -> String {
	let empty: Vec<Json> = Vec::new();
	let rooms = result.get("rooms").and_then(|v| v.as_arr()).unwrap_or(&empty);

	if rooms.len() <= 1 {
		let seq = result
			.get("msg_seq")
			.and_then(|v| v.as_i64())
			.or_else(|| rooms.first().and_then(|r| r.get("msg_seq")).and_then(|v| v.as_i64()))
			.unwrap_or(0);
		return seq.to_string();
	}
	rooms
		.iter()
		.map(|r| {
			format!(
				"{} {}",
				r.get("room_id").and_then(|v| v.as_str()).unwrap_or(""),
				r.get("msg_seq").and_then(|v| v.as_i64()).unwrap_or(0)
			)
		})
		.collect::<Vec<_>>()
		.join(" / ")
}

/// 待受けの記録。
///
/// 待受けは背面で走るため、外から止められると何も残らない。**1 回の long-poll が
/// 返るたびに 1 行書く。**最後の行の時刻が「最後に生きていた時刻」になる。
pub struct WaitLog {
	path: Option<std::path::PathBuf>,
}

impl WaitLog {
	/// 記録先を決める。テスト用として動いているときは書かない
	pub fn open(root: &std::path::Path, id: &str, is_test: bool) -> WaitLog {
		if is_test {
			return WaitLog { path: None };
		}
		let dir = root.join("logs").join("client");
		if std::fs::create_dir_all(&dir).is_err() {
			return WaitLog { path: None };
		}
		// 名前は yyyymmdd-hhmmss-<ID>.log。ID の末尾にピリオドを許さないのはこのため
		let stamp = jst::now_jst();
		let compact: String = stamp.chars().filter(|c| c.is_ascii_digit()).take(14).collect();
		WaitLog {
			path: Some(dir.join(format!("{}-{}.log", format_stamp(&compact), id))),
		}
	}

	/// 1 行書く。**失敗しても黙って捨てる。**記録のために待受けを止めるのは本末転倒
	pub fn write(&self, level: &str, body: &str) {
		let path = match &self.path {
			Some(p) => p,
			None => return,
		};
		use std::io::Write;
		if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
			let _ = writeln!(f, "{} {:<5} {}", jst::now_jst(), level, body);
		}
	}
}

/// 数字だけを並べた 14 桁を yyyymmdd-hhmmss にする
fn format_stamp(digits: &str) -> String {
	if digits.len() < 14 {
		return digits.to_string();
	}
	format!("{}-{}", &digits[..8], &digits[8..14])
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
	fn 待つ長さを言葉にする() {
		assert_eq!(describe_wait(0), "上限なし");
		assert_eq!(describe_wait(12 * 3600), "12 時間");
		assert_eq!(describe_wait(11 * 60), "11 分");
		assert_eq!(describe_wait(90), "90 秒");
		assert_eq!(describe_wait(3600), "1 時間", "時間が優先");
		assert_eq!(describe_wait(60), "1 分");
	}

	#[test]
	fn 前面の警告は長く待つときだけ出す() {
		// 既定のままなら出さない。既定は 12 時間なので毎回出て意味がなくなる
		assert!(!should_warn_foreground(12 * 3600, true), "既定");
		// 上限なしも出さない。秒数として比べられない
		assert!(!should_warn_foreground(0, false), "上限なし");
		assert!(!should_warn_foreground(FOREGROUND_SEC, false), "ちょうどは出さない");
		assert!(should_warn_foreground(FOREGROUND_SEC + 1, false), "超えたら出す");
		assert!(should_warn_foreground(11 * 60, false), "11 分");
	}

	#[test]
	fn 読んだ位置を1行にする() {
		// 1 ルームなら数だけ
		let one = json::parse(r#"{"msg_seq":42,"rooms":[{"room_id":"public","msg_seq":42}]}"#).unwrap();
		assert_eq!(describe_positions(&one), "42");

		// 複数なら「ルーム 数」を並べる。1 つの数だとどのルームか分からない
		let many = json::parse(r#"{"rooms":[{"room_id":"public","msg_seq":42},{"room_id":"ai-chat-lite","msg_seq":7}]}"#).unwrap();
		assert_eq!(describe_positions(&many), "public 42 / ai-chat-lite 7");
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
