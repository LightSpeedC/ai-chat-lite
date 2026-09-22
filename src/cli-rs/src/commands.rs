//! 各コマンドの中身。
//!
//! 出力は node 版と 1 文字ずつ同じにする。桁は表示幅で揃える（日本語は半角 2 つ分）。

use crate::client::{CallError, Client};
use crate::json::Json;
use crate::jst;
use crate::waiters;
use crate::width::{pad_end, pad_start, width};

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
			"初めての接続です（{}）。当日 0 時・6 時間前の古い方より前の発言は待ちません。それより古い過去が必要なら recent で取ってください（例）:",
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
		let pending = result.get("pending").and_then(|v| v.as_arr()).unwrap_or(&empty).to_vec();

		/*
		 * 前回配信したが未確定の分（pending）を確認し、確定する（i260917-01）。
		 *
		 * wait が応答を返した時点でカーソル（配信済み位置）は進んでいるが、
		 * 確定済み位置はまだ進んでいない。ここで表示して初めて「読んだ」ことに
		 * する。読み飛ばしても、確定しなければ次の wait でまた pending に出る。
		 */
		if !pending.is_empty() {
			println!("前回分（確認）{} 件:", pending.len());
			print_messages(&pending);
			ack_pending(client, id, &result, &pending)?;
			log.write("INFO", &format!("前回分 {} 件を確認し、確定しました", pending.len()));
		}

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

/// pending にあったルームだけ /api/ack を呼び、確定済み位置を進める。
///
/// ルームごとに呼ぶのは、/api/ack が 1 ルーム分ずつしか受けないため。
/// その回の poll で pending が無かったルームは呼ばない（無駄な呼び出しをしない）。
fn ack_pending(client: &Client, id: &str, result: &Json, pending: &[Json]) -> Result<(), CallError> {
	let empty: Vec<Json> = Vec::new();
	let rooms = result.get("rooms").and_then(|v| v.as_arr()).unwrap_or(&empty);
	for room in rooms {
		let room_id = room.get("room_id").and_then(|v| v.as_str()).unwrap_or("");
		let has_pending = pending
			.iter()
			.any(|m| m.get("room_id").and_then(|v| v.as_str()) == Some(room_id));
		if !has_pending {
			continue;
		}
		let since = room.get("since").and_then(|v| v.as_i64()).unwrap_or(0);
		let body = Json::Obj(vec![
			("connector_id".to_string(), Json::Str(id.to_string())),
			("room_id".to_string(), Json::Str(room_id.to_string())),
			("msg_seq".to_string(), Json::Num(since as f64)),
		]);
		client.call("POST", "/api/ack", Some(&body.to_string()), None)?;
	}
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

/// 標準入力から 1 行読む。
///
/// **`y` では通さず、対象の名前を打たせる。**勢いで確定させないため。
/// 打ち間違いや別の対象を指していたときに、そこで気づける。
///
/// 【空行と EOF を分ける】
/// どちらも「答えが空」だが、読み手にとっては別の話である。空行は打ち間違い、
/// EOF は入力が来ていない。案内を出し分けるため、**どちらだったかを返す**。
///
/// 戻り値は `(答え, EOF だったか)`。
pub fn read_line(prompt: &str) -> (String, bool) {
	use std::io::Write;
	print!("{}", prompt);
	let _ = std::io::stdout().flush();

	let mut line = String::new();
	match std::io::stdin().read_line(&mut line) {
		// 0 バイトは EOF。閉じていて 1 文字も来なかった
		Ok(0) => (String::new(), true),
		Ok(_) => (line.trim().to_string(), false),
		Err(_) => (String::new(), true),
	}
}

/// 取り返しのつかない操作の前に、対象の名前を打たせる。
///
/// `--yes` があれば聞かない。背面（run_in_background）から実行するときの唯一の手段で、
/// これが無いと AI は archive ・ rename を使えない。確認を省くので、
/// **打ち間違いは止まらない。**渡した側の責任になる。
///
/// 【中止の理由を書き分ける】
/// 打ち間違えたのか、入力が来なかったのかは、読み手にとって別の話である。
/// 本番では背面から 2 度試して 2 度とも止まり、原因が分からないままになった
/// （課題 i260913-02）。**詰まったその場で渡し方が読めるようにする。**
pub fn confirm_target(yes: bool, target: &str, prompt: &str, command: &str) -> bool {
	if yes {
		return true;
	}

	let (answer, eof) = read_line(prompt);
	if answer == target {
		return true;
	}

	if eof {
		println!("中止しました。標準入力が閉じているため、確認の答えを受け取れませんでした。");
		println!(
			"背面から実行するときは --yes を渡すか、printf '{}\\n' | で答えを渡してください。",
			target
		);
		println!("  例: printf '{}\\n' | aichat {} :<自分の ID>: ...", target, command);
		return false;
	}

	println!("中止しました。");
	false
}

/// 何件片付くかを先に出す。**件数が思っていたより多ければ、そこで気づける**
pub fn print_preview(kind: &str, id: &str, counts: &Json) {
	let num = |key: &str| counts.get(key).and_then(|v| v.as_i64()).unwrap_or(0);
	println!("{} {} を片付けると、次が見えなくなります。", archive_label(kind), id);

	if num("messages") > 0 {
		// 期間が分かると、思っていた範囲と違うことに気づける
		let span = match (
			counts.get("first").and_then(|v| v.as_str()),
			counts.get("last").and_then(|v| v.as_str()),
		) {
			(Some(f), Some(l)) if !f.is_empty() && !l.is_empty() => {
				format!("（{} 〜 {}）", slice_chars(f, 5, 16), slice_chars(l, 5, 16))
			}
			_ => String::new(),
		};
		println!("  発言       {:>4} 件{}", num("messages"), span);
	}
	if num("cursors") > 0 {
		println!("  読んだ位置 {:>4} 件", num("cursors"));
	}
	if num("connectors") > 0 {
		println!("  参加者     {:>4} 件", num("connectors"));
	}
	println!("archives に記録され、restore で戻せます。");
}

/// 文字の位置で切り出す。**バイトではなく文字**で数える
fn slice_chars(text: &str, from: usize, to: usize) -> String {
	text.chars().skip(from).take(to.saturating_sub(from)).collect()
}

/// 片付ける
pub fn archive(
	client: &Client,
	me: &str,
	kind: &str,
	id: &str,
	with_messages: bool,
	description: Option<&str>,
	yes: bool,
) -> Result<i32, CallError> {
	let query = format!(
		"/api/admin/archive-preview?kind={}&id={}{}",
		encode_query(kind),
		encode_query(id),
		if with_messages { "&with_messages=1" } else { "" }
	);
	let counts = client.call("GET", &query, None, None)?;

	let total = ["messages", "cursors", "connectors"]
		.iter()
		.map(|k| counts.get(k).and_then(|v| v.as_i64()).unwrap_or(0))
		.sum::<i64>();
	if total == 0 {
		eprintln!("片付けるものがありません: {} {}", kind, id);
		return Ok(1);
	}

	print_preview(kind, id, &counts);
	if !confirm_target(
		yes,
		id,
		&format!("本当に片付ける場合は「{}」と入力してください: ", id),
		"archive",
	) {
		return Ok(1);
	}

	let mut fields = vec![
		("kind".to_string(), Json::Str(kind.to_string())),
		("id".to_string(), Json::Str(id.to_string())),
		("with_messages".to_string(), Json::Bool(with_messages)),
	];
	// 説明は省略できる。省くとサーバーが組み立てる
	if let Some(d) = description {
		fields.push(("description".to_string(), Json::Str(d.to_string())));
	}
	fields.push(("connector_id".to_string(), Json::Str(me.to_string())));
	fields.push(("confirm".to_string(), Json::Str(id.to_string())));

	let result = client.call("POST", "/api/admin/archive", Some(&Json::Obj(fields).to_string()), None)?;
	let seq = result.get("archived_seq").and_then(|v| v.as_i64()).unwrap_or(0);
	println!("片付けました（archived_seq {}）", seq);
	println!("  {}", result.get("description").and_then(|v| v.as_str()).unwrap_or(""));
	println!("戻すには: restore :{}: {}", me, seq);
	Ok(0)
}

/// 片付けたものをまとめて戻す
pub fn restore(client: &Client, me: &str, seq: i64) -> Result<(), CallError> {
	let body = Json::Obj(vec![
		("archived_seq".to_string(), Json::Num(seq as f64)),
		("connector_id".to_string(), Json::Str(me.to_string())),
	]);
	let result = client.call("POST", "/api/admin/restore", Some(&body.to_string()), None)?;
	println!(
		"archived_seq {} を戻しました（{} 件）",
		result.get("archived_seq").and_then(|v| v.as_i64()).unwrap_or(seq),
		result.get("restored").and_then(|v| v.as_i64()).unwrap_or(0)
	);
	println!("  {}", result.get("description").and_then(|v| v.as_str()).unwrap_or(""));
	Ok(())
}

/// 参加者の ID を付け替える。
///
/// `archive` と同じ形にする。先に件数を出し、旧 ID の入力を求めてから実行する。
/// ID は参加者・読んだ位置・発言（差出人・宛先・本文の @旧ID）・片付けの記録に
/// 散っており、手で書くと洗い出しから毎回やり直しになる。
pub fn rename(client: &Client, me: &str, from: &str, to: &str, yes: bool) -> Result<i32, CallError> {
	let counts = client.call(
		"GET",
		&format!("/api/admin/rename-preview?from={}", encode_query(from)),
		None,
		None,
	)?;
	let num = |key: &str| counts.get(key).and_then(|v| v.as_i64()).unwrap_or(0);

	println!("参加者 {} を {} に付け替えます。", from, to);
	println!("  参加者        {:>4} 件", num("connectors"));
	println!("  読んだ位置    {:>4} 件", num("cursors"));
	println!("  発言（差出人）{:>4} 件", num("messages_from"));
	println!("  発言（宛先）  {:>4} 件", num("messages_to"));
	println!("  発言（本文の @{}）{:>4} 件", from, num("messages_body"));
	println!("  片付けの記録  {:>4} 件", num("archives") + num("archive_targets"));
	println!("走っている待受けがあると断られます。先に止めてください。");

	if !confirm_target(
		yes,
		from,
		&format!("本当に付け替える場合は「{}」と入力してください: ", from),
		"rename",
	) {
		return Ok(1);
	}

	let body = Json::Obj(vec![
		("from".to_string(), Json::Str(from.to_string())),
		("to".to_string(), Json::Str(to.to_string())),
		("connector_id".to_string(), Json::Str(me.to_string())),
		("confirm".to_string(), Json::Str(from.to_string())),
	]);
	let result = client.call("POST", "/api/admin/rename", Some(&body.to_string()), None)?;

	// 散っている置き場をすべて足す。1 つでも漏れると「直したつもり」になる
	let total: i64 = [
		"connectors",
		"cursors",
		"messages_from",
		"messages_to",
		"messages_body",
		"archives",
		"archive_targets",
	]
	.iter()
	.map(|k| result.get(k).and_then(|v| v.as_i64()).unwrap_or(0))
	.sum();

	println!(
		"付け替えました（{} → {} / {} 件）",
		result.get("from").and_then(|v| v.as_str()).unwrap_or(from),
		result.get("to").and_then(|v| v.as_str()).unwrap_or(to),
		total
	);
	println!("  待受けを張り直すときは、新しい ID で張ってください。");
	Ok(0)
}

/// 落とす。**再起動されるかどうかは終了コードで決まる。**
///
///   `restart` … 終了コード 1。異常終了として扱われ、10 秒後に起動し直す
///   `stop`    … 終了コード 0。正常終了として扱われ、止まったまま
///
/// サービスの再起動と違い管理者権限が要らないため、ソースを直したあとの反映に使える。
pub fn exit_server(client: &Client, me: &str, exit_code: i64) -> Result<(), CallError> {
	let body = Json::Obj(vec![
		("connector_id".to_string(), Json::Str(me.to_string())),
		("exit_code".to_string(), Json::Num(exit_code as f64)),
	]);
	let result = client.call("POST", "/api/admin/exit", Some(&body.to_string()), None)?;

	println!(
		"終了コード {} で終了します",
		result.get("exit_code").and_then(|v| v.as_i64()).unwrap_or(exit_code)
	);
	println!("  {}", result.get("note").and_then(|v| v.as_str()).unwrap_or(""));

	// 次に何をすればよいかは、サーバーの答えで変わる
	if result.get("will_restart").and_then(|v| v.as_bool()).unwrap_or(false) {
		println!("  10 秒ほど待ってから接続してください");
	} else if result.get("managed_by").map(|v| !v.is_null()).unwrap_or(false) {
		println!("  もう一度動かすには: node-ai-chat-lite-winsw.exe start");
	}
	Ok(())
}

/// `waiters` に渡す基準。どこを見ている待受けを数えるか
pub struct Basis {
	pub label: String,
	pub port: i64,
	pub rooms: Vec<String>,
	/// 見本に出す接続先（`-p 8787` の形）
	pub where_: String,
}

/// 1 本の待受けを、表に出せる形にまとめたもの
struct Row {
	pid: i64,
	id: String,
	via: String,
	at: String,
	target: waiters::Target,
}

/// 走っている待受けを数えて出す。**サーバーには繋がない**
pub fn waiters_cmd(me: &str, basis: &Basis, default_room: &str) -> Result<(), String> {
	let rows = waiters::list_processes()?;
	let self_pid = std::process::id() as i64;
	let picked = waiters::pick_waiters(&rows, &[self_pid]);

	// 親の名前を引けるようにしておく。cmd 越しの node は aichat-node になる
	let name_of: Vec<(i64, String)> = rows.iter().map(|p| (p.pid, p.name.clone())).collect();

	let all: Vec<Row> = picked
		.iter()
		.map(|(p, id)| Row {
			pid: p.pid,
			id: id.clone(),
			via: waiters::via_of(
				&p.name,
				name_of.iter().find(|(pid, _)| *pid == p.ppid).map(|(_, n)| n.as_str()),
			),
			at: p.at.clone(),
			target: waiters::target_of(&p.cmd, default_room),
		})
		.collect();

	if all.is_empty() {
		println!("待受けは走っていません。");
		println!("  {} の待受けがありません。次を張ってください:", basis.rooms.join(", "));
		println!(
			"    aichat wait :{}: {} -r {}",
			me,
			basis.where_,
			waiters::rooms_arg(&basis.rooms)
		);
		return Ok(());
	}

	print_waiters(&all, basis, me);
	Ok(())
}

/// 一覧を出す
fn print_waiters(all: &[Row], basis: &Basis, me: &str) {
	// 同じ接続先の分を並べる。ルームは列に出す。1 本が複数を見ていることがある
	let here: Vec<&Row> = all.iter().filter(|h| h.target.port == basis.port).collect();
	let elsewhere: Vec<&Row> = all.iter().filter(|h| h.target.port != basis.port).collect();

	println!("  {} を見ている待受け", basis.label);
	println!();

	if here.is_empty() {
		println!("  ありません。");
	} else {
		let rooms_of = |h: &Row| h.target.rooms.join(", ");
		let id_w = here.iter().map(|h| width(&h.id)).chain(std::iter::once(width("ID"))).max().unwrap_or(2);
		let via_w = here.iter().map(|h| width(&h.via)).chain(std::iter::once(width("張り方"))).max().unwrap_or(6);
		let room_w = here
			.iter()
			.map(|h| width(&rooms_of(h)))
			.chain(std::iter::once(width("ルーム")))
			.max()
			.unwrap_or(6);

		println!(
			"  {}  {}  {}  {}  {}  {}",
			pad_end("ID", id_w),
			pad_end("張り方", via_w),
			pad_end("いつから", 8),
			pad_start("経過", 5),
			pad_end("ルーム", room_w),
			pad_start("pid", 6)
		);

		let now = jst::parse_jst(&jst::now_jst()).unwrap_or(0);
		for h in &here {
			// 自分の分に印を付ける。止めてよいのはこれだけである
			let mark = if h.id == me { "*" } else { " " };
			// at は `yyyy-MM-dd HH:mm:ss`。時刻の部分だけを出す
			let time = if h.at.len() > 11 { &h.at[11..] } else { "" };
			println!(
				"{} {}  {}  {}  {}  {}  {}",
				mark,
				pad_end(&h.id, id_w),
				pad_end(&h.via, via_w),
				time,
				pad_start(&waiters::elapsed_of(&h.at, now), 5),
				pad_end(&rooms_of(h), room_w),
				pad_start(&h.pid.to_string(), 6)
			);
		}
	}

	let mine: Vec<&&Row> = here.iter().filter(|h| h.id == me).collect();

	println!();
	println!("  自分（{}）: {} 本 / この場所に {} 本", me, mine.len(), here.len());

	/*
	 * 別の場所を見ている自分の分は、pid まで出す。
	 *
	 * ルームを間違えた待受けは静かに動く。繋がっているので who は「接続中」と
	 * 出すが、この場所の発言は 1 つも届かない。件数だけでは止めようがない。
	 * 他プロジェクトの分は件数だけにする（止めてはいけないため）。
	 */
	let stray: Vec<&&Row> = elsewhere.iter().filter(|h| h.id == me).collect();
	if !stray.is_empty() {
		let shown: Vec<String> = stray
			.iter()
			.map(|h| format!("pid {}（{} / {}）", h.pid, h.target.label, h.target.rooms.join(", ")))
			.collect();
		println!("  自分の分が別の場所に {} 本: {}", stray.len(), shown.join("、"));
	}

	// elsewhere は接続先が違う分だけ。同じ接続先ならルームが違っても表に出ている
	let others = elsewhere.len() - stray.len();
	if others > 0 {
		println!("  他に {} 本（別の接続先）", others);
	}

	/*
	 * 覆えているかで見る。本数では見ない。
	 *
	 * 1 本が複数のルームを見られるので、「2 ルームなら 2 本」は成り立たない。
	 * 渡したルームが 1 つでも欠けていれば、そこを名指しして張り方を出す。
	 */
	let mut covered: Vec<String> = Vec::new();
	for h in &mine {
		for r in &h.target.rooms {
			if !covered.contains(r) {
				covered.push(r.clone());
			}
		}
	}
	let missing: Vec<String> = basis.rooms.iter().filter(|r| !covered.contains(r)).cloned().collect();

	// 残すものと止めてよいものに分ける。選び方は waiters.rs に置いた
	let mine_waiters: Vec<waiters::Waiter> = mine
		.iter()
		.map(|h| waiters::Waiter {
			pid: h.pid,
			rooms: h.target.rooms.clone(),
			at: h.at.clone(),
		})
		.collect();
	let (keep, stop) = waiters::split_redundant(&mine_waiters, &basis.rooms);

	/*
	 * やることは 1 つとは限らない。片方で打ち切ると、もう片方が隠れる。
	 * 「足りない」と「余っている」は同時に起こる。
	 */
	if !missing.is_empty() {
		println!("  {} の待受けがありません。次を張ってください:", missing.join(", "));
		println!(
			"    aichat wait :{}: {} -r {}",
			me,
			basis.where_,
			waiters::rooms_arg(&missing)
		);
	}

	if !stop.is_empty() {
		// 出すのも基準の中だけ。渡していないルームの名前を混ぜない
		let mut rooms: Vec<String> = Vec::new();
		for w in &stop {
			for r in &w.rooms {
				if basis.rooms.contains(r) && !rooms.contains(r) {
					rooms.push(r.clone());
				}
			}
		}
		let stopped: Vec<String> = stop.iter().map(|w| w.pid.to_string()).collect();
		let kept: Vec<String> = keep.iter().map(|w| w.pid.to_string()).collect();
		println!(
			"  {} を二重に張っています。pid {} を止めてください（pid {} を残す）。",
			rooms.join(", "),
			stopped.join(", "),
			kept.join(", ")
		);
	}

	if missing.is_empty() && stop.is_empty() {
		println!("  すべて覆えています。張る必要はありません。");
	}
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
