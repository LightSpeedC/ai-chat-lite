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
