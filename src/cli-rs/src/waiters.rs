//! 走っている待受けの読み取りと、残すもの・止めてよいものへの分け方。
//!
//! node 版の `waiters-pick.mjs` と同じ規則にする。**ここを間違えると事故になる。**
//! 数え違いで他プロジェクトの待受けを止めると、相手は原因不明の `exit 255` で
//! 落ちる（課題 i260901-07 で実際に起きた）。
//!
//! 外部クレートを使わないので正規表現は持たない。`readArg` に当たる読み取りは
//! 手で書く。

/// 1 本の待受け
#[derive(Debug, Clone, PartialEq)]
pub struct Waiter {
	pub pid: i64,
	/// 覆っているルーム
	pub rooms: Vec<String>,
	/// 立った時刻（`yyyy/mm/dd HH:mm:ss.fff`）。並べ替えに使う
	pub at: String,
}

/// 走っているプロセス 1 つ
#[derive(Debug, Clone, PartialEq)]
pub struct Process {
	pub pid: i64,
	pub ppid: i64,
	/// 実行ファイルの名前（`aichat-rs.exe` ・ `node.exe` など）
	pub name: String,
	pub cmd: String,
	/// 立った時刻（`yyyy-MM-dd HH:mm:ss`）
	pub at: String,
}

/// 経過を `h:mm` で返す。**日をまたいでも時のまま増やす**（2 日なら 48:00）。
///
/// 日数に繰り上げると、張りっぱなしの待受けが「2 日」と出て、何時間走って
/// いるのか読めなくなる。
pub fn elapsed_of(at: &str, now_ms: i64) -> String {
	// at は `yyyy-MM-dd HH:mm:ss`（ps ・ Get-CimInstance の形）
	let started = parse_at(at).unwrap_or(now_ms);
	let min = ((now_ms - started) / 60000).max(0);
	format!("{}:{:02}", min / 60, min % 60)
}

/// `yyyy-MM-dd HH:mm:ss` を JST としてのミリ秒に直す
fn parse_at(at: &str) -> Option<i64> {
	// jst の読み取りは `yyyy/mm/dd HH:mm:ss.fff` なので、区切りを合わせてから渡す
	let (date, time) = at.split_once(' ')?;
	let slashed = date.replace('-', "/");
	crate::jst::parse_jst(&format!("{} {}.000", slashed, time)).ok()
}

/// 委譲先の実行ファイル名（Windows 専用）
const DELEGATE_NAME: &str = "aichat-cs.exe";

/// Windows で `waiters` を任せる相手を探す。
///
/// **C# は .NET から WMI を直に叩ける。**こちらは PowerShell を起こすしかなく、
/// その起動だけで 213 ms を使う。同じ答えを出すのに 2.5 倍かかるので、
/// 隣に C# 版が置いてあるならそちらに任せる。
///
/// **同じフォルダだけを見る。**PATH を辿ると、別の版や別プロジェクトのものを
/// 掴みうる。自分と一緒に配られたものだけを相手にする。
///
/// Windows 以外では常に `None`。`ps` で足りるので任せる理由がない。
pub fn delegate_for_waiters(exe_dir: Option<&std::path::Path>, is_windows: bool) -> Option<std::path::PathBuf> {
	if !is_windows {
		return None;
	}
	let target = exe_dir?.join(DELEGATE_NAME);
	if target.is_file() {
		Some(target)
	} else {
		None
	}
}

/// いま走っている実行ファイルの置き場
pub fn exe_dir() -> Option<std::path::PathBuf> {
	std::env::current_exe().ok()?.parent().map(|p| p.to_path_buf())
}

/// 走っているプロセスの一覧を取る。
///
/// **ここだけ OS で分かれる。**Mac ・ Linux に PowerShell は無い。
/// 取り方だけを分け、選び方（`pick_waiters`）は 1 つに保つ。
///
/// Windows では 2 段で試す。
///
///   1. Windows の API を直に呼ぶ（20 ms）
///   2. PowerShell を起こす（213 ms）
///
/// **1 は非公開の仕組みに乗っている。**PEB の並びは公開されておらず、
/// Windows の版が変わると位置がずれうる。そのときは黙って 2 へ落ちる。
/// `waiters` は「止めてよい待受けを名指しする」道具なので、
/// **誤って数えるより遅いほうがよい。**
pub fn list_processes() -> Result<Vec<Process>, String> {
	if !cfg!(windows) {
		return list_unix();
	}

	#[cfg(windows)]
	{
		// 空が返ったときも失敗として扱う。1 件も無いことは起こらない
		if let Ok(rows) = crate::winapi::list_processes() {
			if !rows.is_empty() {
				return Ok(rows);
			}
		}
	}
	list_windows()
}

/// Windows。`Get-CimInstance` で立った時刻まで取れる
fn list_windows() -> Result<Vec<Process>, String> {
	let script = "Get-CimInstance Win32_Process | \
		Where-Object { $_.CommandLine -and $_.CommandLine -like '*wait*' } | \
		ForEach-Object { \"$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.Name)`t$($_.CreationDate.ToString('yyyy-MM-dd HH:mm:ss'))`t$($_.CommandLine)\" }";

	let out = std::process::Command::new("powershell")
		.args(["-NoProfile", "-NonInteractive", "-Command", script])
		.output()
		.map_err(|e| format!("powershell が動きませんでした: {}", e))?;

	if !out.status.success() {
		let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
		return Err(if err.is_empty() { "powershell が動きませんでした".to_string() } else { err });
	}
	Ok(parse_rows(&String::from_utf8_lossy(&out.stdout), 5))
}

/// Mac ・ Linux。`ps` で親と起動時刻まで取る
fn list_unix() -> Result<Vec<Process>, String> {
	let out = std::process::Command::new("ps")
		.args(["-eo", "pid=,ppid=,lstart=,comm=,args="])
		.output()
		.map_err(|e| format!("ps が動きませんでした: {}", e))?;

	if !out.status.success() {
		return Err("ps が動きませんでした".to_string());
	}

	// ps は桁で揃えて返すので、空白で区切って読む
	let mut rows = Vec::new();
	for line in String::from_utf8_lossy(&out.stdout).lines() {
		let mut it = line.split_whitespace();
		let pid: i64 = match it.next().and_then(|s| s.parse().ok()) {
			Some(v) => v,
			None => continue,
		};
		let ppid: i64 = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
		// lstart は 5 語（曜 月 日 時刻 年）。並べ替えに使うので順に並ぶ形へ直す
		let stamp: Vec<&str> = (0..5).filter_map(|_| it.next()).collect();
		let name = it.next().unwrap_or("").to_string();
		let cmd = it.collect::<Vec<_>>().join(" ");
		if !cmd.contains("wait") {
			continue;
		}
		rows.push(Process { pid, ppid, name, at: normalize_lstart(&stamp), cmd });
	}
	Ok(rows)
}

/// `ps` の `Www Mmm dd hh:mm:ss yyyy` を `yyyy-MM-dd HH:mm:ss` に直す。
///
/// **並べ替えに使うので、文字列のまま比べて時系列になる形にする。**
fn normalize_lstart(parts: &[&str]) -> String {
	if parts.len() < 5 {
		return String::new();
	}
	let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
	let month = months.iter().position(|m| *m == parts[1]).map(|i| i + 1).unwrap_or(0);
	let day: u32 = parts[2].parse().unwrap_or(0);
	format!("{}-{:02}-{:02} {}", parts[4], month, day, parts[3])
}

/// タブ区切りの行を読む。項目が足りない行は捨てる
fn parse_rows(text: &str, fields: usize) -> Vec<Process> {
	let mut rows = Vec::new();
	for line in text.lines() {
		let parts: Vec<&str> = line.splitn(fields, '\t').collect();
		if parts.len() < fields {
			continue;
		}
		let pid: i64 = match parts[0].trim().parse() {
			Ok(v) => v,
			Err(_) => continue,
		};
		rows.push(Process {
			pid,
			ppid: parts[1].trim().parse().unwrap_or(0),
			name: parts[2].trim().to_string(),
			at: parts[3].trim().to_string(),
			cmd: parts[4].trim().to_string(),
		});
	}
	rows
}

/// コマンドラインから待受けの ID を取り出す。
///
/// node 版は `WAITER_PATTERN` の正規表現で見ているが、外部クレートを使わないので
/// 同じ判定を手で書く。**`wait` の後ろに空白を要求するのが要点。**これが無いと
/// `waiters` 自身に一致し、数えているコマンドが数に入る。
///
/// 古い形（`-c` ・ `--connector-id`）も拾う。切り替えの途中は新旧が混ざるため、
/// 片方しか見ないと相手の待受けを見落として二重に張らせてしまう。
pub fn waiter_id(cmd: &str) -> Option<String> {
	let bytes = cmd.as_bytes();
	let mut from = 0;

	while let Some(found) = cmd[from..].find("wait") {
		let start = from + found;
		let end = start + 4;
		from = end;

		// 語の頭であること（行頭か空白のあと）
		let head_ok = start == 0 || bytes[start - 1].is_ascii_whitespace();
		// 直後に空白があること。waiters に当たらないようにする
		let tail_ok = end < bytes.len() && bytes[end].is_ascii_whitespace();
		if !head_ok || !tail_ok {
			continue;
		}

		let rest = cmd[end..].trim_start();

		// 新しい形: :id: で囲まれている
		if let Some(inner) = rest.strip_prefix(':') {
			if let Some(close) = inner.find(':') {
				let id = &inner[..close];
				if !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c)) {
					return Some(id.to_string());
				}
			}
		}

		// 古い形: -c <id> / --connector-id <id>
		for name in ["--connector-id", "-c"] {
			if let Some(after) = rest.strip_prefix(name) {
				if after.starts_with(|c: char| c.is_ascii_whitespace()) {
					let id: String = after.trim_start().chars().take_while(|c| !c.is_whitespace() && *c != '"').collect();
					if !id.is_empty() {
						return Some(id);
					}
				}
			}
		}
	}
	None
}

/// 待受けが見ている先
#[derive(Debug, Clone, PartialEq)]
pub struct Target {
	/// 案内に出す形（`:8787` ・ `example:9000` ・ `(未指定)`）
	pub label: String,
	pub rooms: Vec<String>,
	/// 同じ場所かを比べるための番号。読めなければ 0
	pub port: i64,
}

/// コマンドラインから、その待受けが見ている先を読む
pub fn target_of(cmd: &str, default_room: &str) -> Target {
	let port = read_arg(cmd, "port", "p");
	let url = read_arg(cmd, "url", "u");
	// 1 本が複数のルームを見られる。カンマで割って持つ
	let rooms = rooms_from(read_arg(cmd, "room", "r").as_deref(), default_room);

	if let Some(p) = port {
		let num = p.parse().unwrap_or(0);
		return Target { label: format!(":{}", p), rooms, port: num };
	}
	if let Some(u) = url {
		// 仕組みの名前は落として host:port だけ出す
		let mut label = match u.find("://") {
			Some(i) => u[i + 3..].to_string(),
			None => u.clone(),
		};
		while label.ends_with('/') {
			label.pop();
		}
		// 末尾の :数字 を番号として読む
		let num = label
			.rsplit_once(':')
			.and_then(|(_, tail)| tail.parse::<i64>().ok())
			.unwrap_or(0);
		return Target { label, rooms, port: num };
	}
	Target { label: "(未指定)".to_string(), rooms, port: 0 }
}

/// 張り方の名前。出力に出るのは `aichat` ・ `aichat-node` ・ `node` の 3 つ
pub fn via_of(name: &str, parent_name: Option<&str>) -> String {
	let lower = name.to_ascii_lowercase();
	if lower == "aichat.exe" || lower == "aichat-rs.exe" || lower == "aichat-cs.exe" {
		return lower.trim_end_matches(".exe").to_string();
	}
	if lower == "node.exe" || lower == "node" {
		let parent = parent_name.unwrap_or("").to_ascii_lowercase();
		return if parent == "cmd.exe" { "aichat-node".to_string() } else { "node".to_string() };
	}
	lower.trim_end_matches(".exe").to_string()
}

/// 一覧から待受けだけを選ぶ。
///
/// **親を落とす。**`cmd.exe → node.exe` と連なるとき、途中の段はすべて同じ
/// コマンドラインを抱えているため全部が当たる。当たったものの直親を落とすと、
/// 連鎖でも末端 1 つだけが残る。
pub fn pick_waiters(rows: &[Process], exclude_pids: &[i64]) -> Vec<(Process, String)> {
	let hits: Vec<(Process, String)> = rows
		.iter()
		.filter(|r| !exclude_pids.contains(&r.pid))
		.filter_map(|r| waiter_id(&r.cmd).map(|id| (r.clone(), id)))
		.collect();

	let parents: Vec<i64> = hits.iter().map(|(p, _)| p.ppid).collect();
	let mut leaves: Vec<(Process, String)> = hits
		.iter()
		.filter(|(p, _)| !parents.contains(&p.pid))
		.cloned()
		.collect();

	// 古い順。同じ時刻なら pid の小さい順
	leaves.sort_by(|(a, _), (b, _)| a.at.cmp(&b.at).then(a.pid.cmp(&b.pid)));
	leaves
}

/// コマンドラインから `--名前 値` を読む。短い形も同じ値として受ける。
///
/// **ダブルクォートの囲みを剥がす。**共通ルールは、カンマ区切りで複数のルームを
/// 渡すとき `-r "public,ai-chat-lite"` と囲むよう定めている。cmd 経由の
/// ランチャーは引数を素通しするので、囲みは子プロセスのコマンドラインに残る。
///
/// 囲みを読み落とすと、2 ルームを覆っている待受けが 1 ルームと数えられ、
/// 「待受けがありません。張ってください」と出る。**共通ルールが最も強く禁じる
/// 「同じルームを 2 本で見ない」を、道具の出力が指示する形になる。**
pub fn read_arg(cmd: &str, long: &str, short: &str) -> Option<String> {
	for name in [format!("--{}", long), format!("-{}", short)] {
		if let Some(value) = read_named(cmd, &name) {
			return Some(value);
		}
	}
	None
}

/// `<名前> <値>` を 1 つ読む。名前は語の境目で区切れていること
fn read_named(cmd: &str, name: &str) -> Option<String> {
	let bytes = cmd.as_bytes();
	let mut from = 0;

	while let Some(found) = cmd[from..].find(name) {
		let start = from + found;
		let end = start + name.len();
		from = end;

		// 語の頭であること。--room を探して -r に当たらないようにする
		let head_ok = start == 0 || bytes[start - 1].is_ascii_whitespace();
		// 語の尻であること。-r を探して --reply-to に当たらないようにする
		let tail_ok = end < bytes.len() && bytes[end].is_ascii_whitespace();
		if !head_ok || !tail_ok {
			continue;
		}

		// 空白を飛ばして値の頭へ
		let rest = cmd[end..].trim_start();
		if rest.is_empty() {
			return None;
		}

		// 囲まれていれば中身を、囲まれていなければ空白までを値にする
		if let Some(inner) = rest.strip_prefix('"') {
			return inner.find('"').map(|close| inner[..close].to_string());
		}
		let value: String = rest.chars().take_while(|c| !c.is_whitespace() && *c != '"').collect();
		return if value.is_empty() { None } else { Some(value) };
	}
	None
}

/// `-r` の値をルームの並びにする。省略なら既定のルーム 1 つ。重複は落とす。
pub fn rooms_from(value: Option<&str>, default_room: &str) -> Vec<String> {
	let raw = value.unwrap_or("").trim();
	if raw.is_empty() {
		return vec![default_room.to_string()];
	}
	let mut seen: Vec<String> = Vec::new();
	for part in raw.split(',') {
		let room = part.trim();
		if !room.is_empty() && !seen.iter().any(|r| r == room) {
			seen.push(room.to_string());
		}
	}
	if seen.is_empty() {
		vec![default_room.to_string()]
	} else {
		seen
	}
}

/// 案内に出すルームの並び。**複数ならダブルクォートで囲む。**
///
/// 囲まないと PowerShell がカンマを配列の区切りと読み、2 つの引数に割れて
/// 1 ルームだけを待つ。エラーは出ず、届かないことにも気づけない。
pub fn rooms_arg(rooms: &[String]) -> String {
	let joined = rooms.join(",");
	if rooms.len() > 1 {
		format!("\"{}\"", joined)
	} else {
		joined
	}
}

/// 残すものと止めてよいものに分ける。
///
/// 止めてよいのは、**覆っている全ルームが他の待受けでも覆われているものだけ**。
/// 「2 本目以降を止める」にすると、そのルームを覆う唯一の 1 本まで名指しする。
/// 言われたとおり止めれば覆えなくなり、張り直す → また二重、を往復する。
///
/// 判定に入れるのは基準（`-r` で渡したルーム）に触れる待受けだけ。基準を見ずに
/// 全部を並べると、渡していないルームの pid を止めろと出る。
///
/// 並びは基準の外を多く持つものを先に。止められるものをより多く見つけられる。
/// 古い順は、基準の外の数が同じときの決め方として残す。
pub fn split_redundant(mine: &[Waiter], basis_rooms: &[String]) -> (Vec<Waiter>, Vec<Waiter>) {
	let in_basis = |room: &String| basis_rooms.iter().any(|b| b == room);
	let outside_count = |w: &Waiter| w.rooms.iter().filter(|r| !in_basis(r)).count();

	// 基準に触れるものだけを並べる
	let mut order: Vec<&Waiter> = mine.iter().filter(|w| w.rooms.iter().any(in_basis)).collect();

	// 外を多く持つものを先に。同じなら古い順
	order.sort_by(|a, b| outside_count(b).cmp(&outside_count(a)).then_with(|| a.at.cmp(&b.at)));

	let mut keep = Vec::new();
	let mut stop = Vec::new();
	let mut held: Vec<String> = Vec::new();

	for w in order {
		// 覆っている全ルームが既に覆われているものだけを止める
		if w.rooms.iter().all(|room| held.iter().any(|h| h == room)) {
			stop.push(w.clone());
			continue;
		}
		keep.push(w.clone());
		for room in &w.rooms {
			if !held.iter().any(|h| h == room) {
				held.push(room.clone());
			}
		}
	}
	(keep, stop)
}

#[cfg(test)]
mod tests {
	use super::*;

	fn waiter(pid: i64, rooms: &[&str], at: &str) -> Waiter {
		Waiter {
			pid,
			rooms: rooms.iter().map(|s| s.to_string()).collect(),
			at: at.to_string(),
		}
	}

	fn strs(items: &[&str]) -> Vec<String> {
		items.iter().map(|s| s.to_string()).collect()
	}

	fn pids(waiters: &[Waiter]) -> Vec<i64> {
		waiters.iter().map(|w| w.pid).collect()
	}

	fn proc(pid: i64, ppid: i64, name: &str, cmd: &str, at: &str) -> Process {
		Process { pid, ppid, name: name.to_string(), cmd: cmd.to_string(), at: at.to_string() }
	}

	/// 経過のテスト用。基準の時刻をミリ秒で作る
	fn at_ms(text: &str) -> i64 {
		crate::jst::parse_jst(text).unwrap()
	}

	#[test]
	fn 経過を時と分で出す() {
		let now = at_ms("2026/09/13 12:34:00.000");
		assert_eq!(elapsed_of("2026-09-13 12:34:00", now), "0:00");
		assert_eq!(elapsed_of("2026-09-13 12:00:00", now), "0:34");
		assert_eq!(elapsed_of("2026-09-13 10:34:00", now), "2:00");
		assert_eq!(elapsed_of("2026-09-13 10:00:00", now), "2:34");
	}

	#[test]
	fn 日をまたいでも時のまま増やす() {
		// 「2 日」と出すと、何時間走っているのか読めなくなる
		let now = at_ms("2026/09/15 10:00:00.000");
		assert_eq!(elapsed_of("2026-09-13 10:00:00", now), "48:00");
	}

	#[test]
	fn 先の時刻なら0にする() {
		// 時計のずれで未来に見えることがある。負の経過は出さない
		let now = at_ms("2026/09/13 10:00:00.000");
		assert_eq!(elapsed_of("2026-09-13 12:00:00", now), "0:00");
	}

	#[test]
	fn 読めない時刻は0にする() {
		let now = at_ms("2026/09/13 10:00:00.000");
		assert_eq!(elapsed_of("", now), "0:00");
		assert_eq!(elapsed_of("いつか", now), "0:00");
	}

	#[test]
	fn 隣にC版があればそちらに任せる() {
		// 一時の置き場を作り、そこに委譲先を置いてみる
		let dir = std::env::temp_dir().join(format!("aichat-rs-test-{}", std::process::id()));
		let _ = std::fs::create_dir_all(&dir);
		let target = dir.join(DELEGATE_NAME);
		let _ = std::fs::write(&target, b"dummy");

		assert_eq!(delegate_for_waiters(Some(&dir), true), Some(target.clone()));

		let _ = std::fs::remove_file(&target);
		let _ = std::fs::remove_dir(&dir);
	}

	#[test]
	fn 隣に無ければ自分で数える() {
		let dir = std::env::temp_dir().join(format!("aichat-rs-empty-{}", std::process::id()));
		let _ = std::fs::create_dir_all(&dir);
		assert_eq!(delegate_for_waiters(Some(&dir), true), None);
		let _ = std::fs::remove_dir(&dir);
	}

	#[test]
	fn Windows以外では任せない() {
		// ps で足りるので、任せる理由がない
		let dir = std::env::temp_dir().join(format!("aichat-rs-unix-{}", std::process::id()));
		let _ = std::fs::create_dir_all(&dir);
		let target = dir.join(DELEGATE_NAME);
		let _ = std::fs::write(&target, b"dummy");

		assert_eq!(delegate_for_waiters(Some(&dir), false), None);

		let _ = std::fs::remove_file(&target);
		let _ = std::fs::remove_dir(&dir);
	}

	#[test]
	fn 置き場が分からなければ任せない() {
		// PATH を辿ると別の版や別プロジェクトのものを掴みうる
		assert_eq!(delegate_for_waiters(None, true), None);
	}

	#[test]
	fn タブ区切りの行を読む() {
		let text = "100\t1\taichat.exe\t2026-09-13 10:00:00\taichat wait :me: -p 8787\n";
		let rows = parse_rows(text, 5);
		assert_eq!(rows.len(), 1);
		assert_eq!(rows[0].pid, 100);
		assert_eq!(rows[0].ppid, 1);
		assert_eq!(rows[0].name, "aichat.exe");
		assert_eq!(rows[0].at, "2026-09-13 10:00:00");
		assert_eq!(rows[0].cmd, "aichat wait :me: -p 8787");
	}

	#[test]
	fn コマンドラインにタブが入っていても切らない() {
		// 5 つに分けたあとは残り全部が本文。途中で切ると ID を見失う
		let text = "100\t1\tnode.exe\t2026-09-13 10:00:00\tnode chat.mjs wait :me:\tあまり\n";
		let rows = parse_rows(text, 5);
		assert_eq!(rows[0].cmd, "node chat.mjs wait :me:\tあまり");
	}

	#[test]
	fn 項目が足りない行は捨てる() {
		assert!(parse_rows("100\t1\n", 5).is_empty());
		assert!(parse_rows("", 5).is_empty());
		assert!(parse_rows("数でない\t1\tx\ty\tz\n", 5).is_empty());
	}

	#[test]
	fn psの時刻を並べ替えられる形に直す() {
		// Www Mmm dd hh:mm:ss yyyy → yyyy-MM-dd HH:mm:ss
		let parts = vec!["Sat", "Sep", "13", "10:00:00", "2026"];
		assert_eq!(normalize_lstart(&parts), "2026-09-13 10:00:00");

		// 1 桁の日も 2 桁に詰める。詰めないと文字列の比較で順が崩れる
		let parts = vec!["Tue", "Jan", "5", "09:30:00", "2027"];
		assert_eq!(normalize_lstart(&parts), "2027-01-05 09:30:00");
	}

	#[test]
	fn 直した時刻は文字列のまま時系列になる() {
		let a = normalize_lstart(&["Sat", "Sep", "13", "10:00:00", "2026"]);
		let b = normalize_lstart(&["Tue", "Jan", "5", "09:30:00", "2027"]);
		assert!(a < b, "年をまたいで順が崩れた: {} / {}", a, b);
	}

	#[test]
	fn 待受けのIDを取り出す() {
		assert_eq!(waiter_id("aichat wait :me: -p 8787").as_deref(), Some("me"));
		assert_eq!(waiter_id("node chat.mjs wait :ai-chat-lite: -r public").as_deref(), Some("ai-chat-lite"));
	}

	#[test]
	fn 古い形のIDも拾う() {
		// 切り替えの途中は新旧が混ざる。片方しか見ないと相手の待受けを見落とす
		assert_eq!(waiter_id("aichat wait -c me -p 8787").as_deref(), Some("me"));
		assert_eq!(waiter_id("aichat wait --connector-id me -p 8787").as_deref(), Some("me"));
	}

	#[test]
	fn 数えているコマンド自身に当たらない() {
		// wait の後ろに空白を要求するのが要点。waiters に当たると数が狂う
		assert_eq!(waiter_id("aichat waiters :me: -p 8787"), None);
		assert_eq!(waiter_id("aichat waiters"), None);
	}

	#[test]
	fn 語の途中のwaitに当たらない() {
		assert_eq!(waiter_id("somewait :me:"), None, "前に文字がある");
		assert_eq!(waiter_id("aichat waiting :me:"), None, "後ろが空白でない");
	}

	#[test]
	fn IDが無ければ拾わない() {
		assert_eq!(waiter_id("aichat wait -p 8787"), None);
		assert_eq!(waiter_id("aichat wait ::"), None, "中身が空");
	}

	#[test]
	fn 見ている先をポートから読む() {
		let t = target_of("aichat wait :me: -p 8787 -r public", "public");
		assert_eq!(t.label, ":8787");
		assert_eq!(t.port, 8787);
		assert_eq!(t.rooms, strs(&["public"]));
	}

	#[test]
	fn 見ている先をURLから読む() {
		// 仕組みの名前は落として host:port だけ出す
		let t = target_of("aichat wait :me: -u http://example:9000/ -r a", "public");
		assert_eq!(t.label, "example:9000");
		assert_eq!(t.port, 9000);
	}

	#[test]
	fn 接続先が無ければ未指定と出す() {
		let t = target_of("aichat wait :me:", "public");
		assert_eq!(t.label, "(未指定)");
		assert_eq!(t.port, 0);
		assert_eq!(t.rooms, strs(&["public"]), "ルームは既定になる");
	}

	#[test]
	fn 囲んで渡した複数ルームを読む() {
		// 囲みを読み落とすと 2 ルームが 1 ルームに見え、二重に張らせてしまう
		let t = target_of("aichat wait :me: -p 8787 -r \"public,ai-chat-lite\"", "public");
		assert_eq!(t.rooms, strs(&["public", "ai-chat-lite"]));
	}

	#[test]
	fn 張り方の名前を決める() {
		assert_eq!(via_of("aichat.exe", None), "aichat");
		assert_eq!(via_of("aichat-rs.exe", None), "aichat-rs");
		// cmd 越しの node は aichat-node。直に呼ばれた node は node
		assert_eq!(via_of("node.exe", Some("cmd.exe")), "aichat-node");
		assert_eq!(via_of("node.exe", Some("pwsh.exe")), "node");
		assert_eq!(via_of("node.exe", None), "node");
	}

	#[test]
	fn 自分と一覧を取る子は外す() {
		let rows = vec![
			proc(100, 1, "aichat.exe", "aichat wait :me: -p 8787", "2026-09-13 10:00:00"),
			proc(200, 1, "aichat.exe", "aichat waiters :me: -p 8787", "2026-09-13 10:00:01"),
		];
		let picked = pick_waiters(&rows, &[200]);
		assert_eq!(picked.len(), 1);
		assert_eq!(picked[0].0.pid, 100);
	}

	#[test]
	fn 連なったプロセスは末端だけを残す() {
		// cmd.exe → node.exe と連なると、途中の段も同じコマンドラインを抱えている
		let rows = vec![
			proc(10, 1, "cmd.exe", "cmd /c aichat wait :me: -p 8787", "2026-09-13 10:00:00"),
			proc(20, 10, "node.exe", "node chat.mjs wait :me: -p 8787", "2026-09-13 10:00:01"),
		];
		let picked = pick_waiters(&rows, &[]);
		assert_eq!(picked.len(), 1, "末端 1 つだけ");
		assert_eq!(picked[0].0.pid, 20);
	}

	#[test]
	fn 古い順に並べる() {
		let rows = vec![
			proc(30, 1, "aichat.exe", "aichat wait :c: -p 1", "2026-09-13 12:00:00"),
			proc(10, 1, "aichat.exe", "aichat wait :a: -p 1", "2026-09-13 10:00:00"),
			proc(20, 1, "aichat.exe", "aichat wait :b: -p 1", "2026-09-13 11:00:00"),
		];
		let picked = pick_waiters(&rows, &[]);
		assert_eq!(picked.iter().map(|(p, _)| p.pid).collect::<Vec<_>>(), vec![10, 20, 30]);
	}

	#[test]
	fn 同じ時刻ならpidの小さい順() {
		let rows = vec![
			proc(20, 1, "aichat.exe", "aichat wait :b: -p 1", "2026-09-13 10:00:00"),
			proc(10, 1, "aichat.exe", "aichat wait :a: -p 1", "2026-09-13 10:00:00"),
		];
		let picked = pick_waiters(&rows, &[]);
		assert_eq!(picked.iter().map(|(p, _)| p.pid).collect::<Vec<_>>(), vec![10, 20]);
	}

	#[test]
	fn 囲まれていない値を読む() {
		let cmd = "aichat wait :me: -p 8787 -r public";
		assert_eq!(read_arg(cmd, "room", "r").as_deref(), Some("public"));
		assert_eq!(read_arg(cmd, "port", "p").as_deref(), Some("8787"));
	}

	#[test]
	fn 長い形でも読む() {
		let cmd = "aichat wait :me: --port 8787 --room public";
		assert_eq!(read_arg(cmd, "room", "r").as_deref(), Some("public"));
	}

	#[test]
	fn ダブルクォートの囲みを剥がす() {
		// 囲みを読み落とすと 2 ルームが 1 ルームに見え、二重に張らせてしまう
		let cmd = "aichat wait :me: -p 8787 -r \"public,ai-chat-lite\"";
		assert_eq!(read_arg(cmd, "room", "r").as_deref(), Some("public,ai-chat-lite"));
	}

	#[test]
	fn 囲みの中の空白も値に含める() {
		let cmd = "aichat wait :me: -r \"a, b\"";
		assert_eq!(read_arg(cmd, "room", "r").as_deref(), Some("a, b"));
	}

	#[test]
	fn 無ければ空で返す() {
		let cmd = "aichat wait :me: -p 8787";
		assert_eq!(read_arg(cmd, "room", "r"), None);
	}

	#[test]
	fn 名前の一部に一致させない() {
		// -r を探しているときに --reply-to や -rr に当たってはいけない
		let cmd = "aichat say :me: --reply-to 12";
		assert_eq!(read_arg(cmd, "room", "r"), None);
	}

	#[test]
	fn 値が無ければ読まない() {
		assert_eq!(read_arg("aichat wait :me: -r", "room", "r"), None);
	}

	#[test]
	fn ルームを分解する() {
		assert_eq!(rooms_from(Some("public"), "public"), strs(&["public"]));
		assert_eq!(rooms_from(Some("a,b"), "public"), strs(&["a", "b"]));
		assert_eq!(rooms_from(Some("a, b ,c"), "public"), strs(&["a", "b", "c"]), "前後の空白を落とす");
	}

	#[test]
	fn ルームの重複を落とす() {
		assert_eq!(rooms_from(Some("a,b,a"), "public"), strs(&["a", "b"]));
	}

	#[test]
	fn 省略なら既定のルーム1つ() {
		assert_eq!(rooms_from(None, "public"), strs(&["public"]));
		assert_eq!(rooms_from(Some(""), "public"), strs(&["public"]));
		assert_eq!(rooms_from(Some("  "), "public"), strs(&["public"]));
		assert_eq!(rooms_from(Some(",,"), "public"), strs(&["public"]));
	}

	#[test]
	fn 単一のルームは囲まない() {
		assert_eq!(rooms_arg(&strs(&["public"])), "public");
	}

	#[test]
	fn 複数のルームはダブルクォートで囲む() {
		// 囲まないと PowerShell がカンマで割り、1 ルームだけを待つ
		assert_eq!(rooms_arg(&strs(&["public", "ai-chat-lite"])), "\"public,ai-chat-lite\"");
	}

	#[test]
	fn 覆いが重なっていなければ全部残す() {
		let mine = vec![waiter(1, &["a"], "2026/09/13 10:00:00.000"), waiter(2, &["b"], "2026/09/13 11:00:00.000")];
		let (keep, stop) = split_redundant(&mine, &strs(&["a", "b"]));
		assert_eq!(pids(&keep), vec![1, 2]);
		assert!(stop.is_empty());
	}

	#[test]
	fn 同じルームを2本で見ていたら片方を止める() {
		let mine = vec![waiter(1, &["a"], "2026/09/13 10:00:00.000"), waiter(2, &["a"], "2026/09/13 11:00:00.000")];
		let (keep, stop) = split_redundant(&mine, &strs(&["a"]));
		assert_eq!(pids(&keep), vec![1], "古いほうを残す");
		assert_eq!(pids(&stop), vec![2]);
	}

	#[test]
	fn 唯一の1本は止めない() {
		// 「2 本目以降を止める」にすると、そのルームを覆う唯一の 1 本まで名指しする
		let mine = vec![
			waiter(1, &["a", "b"], "2026/09/13 10:00:00.000"),
			waiter(2, &["b"], "2026/09/13 11:00:00.000"),
			waiter(3, &["c"], "2026/09/13 12:00:00.000"),
		];
		let (keep, stop) = split_redundant(&mine, &strs(&["a", "b", "c"]));
		assert_eq!(pids(&keep), vec![1, 3]);
		assert_eq!(pids(&stop), vec![2], "b は 1 が覆っている");
	}

	#[test]
	fn 基準の外を多く持つものを先に残す() {
		// 外を多く持つ側を残すと、止められるものをより多く見つけられる
		let mine = vec![
			waiter(1, &["a"], "2026/09/13 10:00:00.000"),
			waiter(2, &["a", "外"], "2026/09/13 11:00:00.000"),
		];
		let (keep, stop) = split_redundant(&mine, &strs(&["a"]));
		assert_eq!(pids(&keep), vec![2], "外を持つ 2 を残す");
		assert_eq!(pids(&stop), vec![1]);
	}

	#[test]
	fn 基準に触れないものは判定に入れない() {
		// 渡していないルームの pid を「止めろ」と出さない
		let mine = vec![
			waiter(1, &["a"], "2026/09/13 10:00:00.000"),
			waiter(2, &["よそ"], "2026/09/13 11:00:00.000"),
		];
		let (keep, stop) = split_redundant(&mine, &strs(&["a"]));
		assert_eq!(pids(&keep), vec![1]);
		assert!(stop.is_empty(), "よそのルームだけを見ている待受けは触らない");
	}

	#[test]
	fn 覆いが同じなら古いほうを残す() {
		// node 版で実測して合わせた（keep: [2] / stop: [1]）
		let mine = vec![
			waiter(1, &["a"], "2026/09/13 12:00:00.000"),
			waiter(2, &["a"], "2026/09/13 10:00:00.000"),
		];
		let (keep, stop) = split_redundant(&mine, &strs(&["a"]));
		assert_eq!(pids(&keep), vec![2], "古いほう");
		assert_eq!(pids(&stop), vec![1]);
	}

	#[test]
	fn 外の数が同じでも中身が違えば両方残す() {
		// 外の数だけで決めない。外 1 と外 2 は別のルームなので、
		// どちらを止めてもそこが覆えなくなる（node 版で実測: keep [2,1] / stop []）
		let mine = vec![
			waiter(1, &["a", "外1"], "2026/09/13 12:00:00.000"),
			waiter(2, &["a", "外2"], "2026/09/13 10:00:00.000"),
		];
		let (keep, stop) = split_redundant(&mine, &strs(&["a"]));
		assert_eq!(pids(&keep), vec![2, 1], "古いほうが先に並ぶ");
		assert!(stop.is_empty());
	}

	#[test]
	fn 持っているルームが違えば両方残す() {
		// 外の数が同じでも、覆っている中身が違えば止められない
		let mine = vec![
			waiter(1, &["a", "外1"], "2026/09/13 10:00:00.000"),
			waiter(2, &["b", "外2"], "2026/09/13 11:00:00.000"),
		];
		let (keep, stop) = split_redundant(&mine, &strs(&["a", "b"]));
		assert_eq!(pids(&keep), vec![1, 2]);
		assert!(stop.is_empty());
	}
}
