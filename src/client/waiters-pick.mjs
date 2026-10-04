/*
 * 走っている待受けの読み取りと、残すものと止めてよいものへの分け方。
 *
 * ここに置くのは、写しにすると守れないからである。chat.mjs に書いてテストへ
 * 貼っていたときは、テストが守るのは写しだけで、本体を壊しても通ってしまった。
 * Rust 版（src/cli-rs/src/waiters.rs）は言語が違うので写しが残る。そちらは
 * tests/cli-rs.test.mjs が出力の書式を突き合わせて守る。
 */

import { WAITER_PATTERN } from './options.mjs';

/**
 * コマンドラインから「--name 値」を読む。短い形も同じ値として受ける。
 *
 * 【クォートを剥がす】
 * 共通ルールと USAGE は、カンマ区切りで複数のルームを渡すときに
 * `-r "public,ai-chat-lite"` とダブルクォートで囲むよう定めている。cmd 経由の
 * ランチャーは引数を素通しするので、囲みは子プロセスのコマンドラインに残る。
 *
 * 以前の式は値から " を除いていた（`([^\s"]+)`）ため、囲んで渡した待受けでは
 * 値の先頭が " で一致せず null になり、roomsFrom(null) が既定の public 1 つを
 * 返していた。**正しく 2 ルーム覆っている待受けが 1 つと数えられ**、
 * 「ai-chat-lite の待受けがありません。張ってください」と出て、共通ルールが
 * 最も強く禁じる「同じルームを 2 本で見ない」を道具の出力が指示する形になる
 * （レビュー #22 medium 7）。
 *
 * 囲まれていれば中身を、囲まれていなければ空白までを値として読む。
 */
export function readArg(cmd, long, short) {
	const head = `(?:^|\\s)(?:--${long}|-${short})\\s+`;
	// 先に「"…" で囲まれた形」を試す。囲みの中に空白やカンマが入っていてもよい
	const quoted = new RegExp(`${head}"([^"]*)"`).exec(cmd);
	if (quoted) return quoted[1];
	const bare = new RegExp(`${head}([^\\s"]+)`).exec(cmd);
	return bare ? bare[1] : null;
}

/**
 * -r の値をルームの配列にする。省略なら既定のルーム 1 つ。重複は落とす。
 *
 * @param {string | null} value
 * @param {string} defaultRoom 省略されたときの行き先
 */
export function roomsFrom(value, defaultRoom) {
	const raw = (value ?? '').trim();
	if (!raw) return [defaultRoom];
	const seen = [];
	for (const part of raw.split(',')) {
		const room = part.trim();
		if (room && !seen.includes(room)) seen.push(room);
	}
	return seen.length > 0 ? seen : [defaultRoom];
}

/**
 * 案内に出すルームの並び。複数ならダブルクォートで囲む。
 *
 * 囲まないと PowerShell がカンマを配列の区切りと読み、2 つの引数に割れて
 * 1 ルームだけを待つ。USAGE は「エラーは出ず、届かないことにも気づけない」と
 * 書いており、共通ルールは「やることは集計より後ろの行に出るので、それに
 * 従う」と定めている。**道具が割れる形の見本を出してはいけない**
 * （レビュー #22 medium 8）。
 *
 * 1 つだけのときは囲まない（共通ルールも「単一のルームなら囲まなくてよい」）。
 *
 * ここに置くのは chat.mjs の中だと呼べず、回帰テストが書けなかったため
 * （レビュー #23 medium 9）。Rust 版（waiters.rs の room_arg）は言語が違うので
 * 写しが残る。そちらは tests/cli-rs.test.mjs が出力の書式で守る。
 *
 * @param {string[]} rooms
 */
export function roomsArg(rooms) {
	const joined = rooms.join(',');
	return rooms.length > 1 ? `"${joined}"` : joined;
}

/**
 * その待受けが「どこを待っているか」を読む。
 *
 * 【なぜ要るのか】
 * 本数だけ数えても、待っている場所が違えば意味がない。とくにルームは
 * 間違えても静かに動く。繋がっているので who は「接続中」と出し、waiters も
 * 1 本と数えるが、public の発言は 1 つも届かない。どこも異常に見えない。
 *
 * ポートは間違えれば繋がらないか別のサーバーに繋がるので、まだ気づける。
 * ルームはそれが無い。だから両方を出す。
 *
 * 値はすべて引数で渡す決まりなので、コマンドラインを読めば分かる。
 * 環境変数で渡せるようにしていないのは、まさにこのためである。
 *
 * @param {string} cmd
 * @param {string} defaultRoom -r が無いときの行き先
 */
export function targetOf(cmd, defaultRoom) {
	const port = readArg(cmd, 'port', 'p');
	const url = readArg(cmd, 'url', 'u');

	// 1 本が複数のルームを見られる。カンマで割って集合として持つ
	const rooms = roomsFrom(readArg(cmd, 'room', 'r'), defaultRoom);

	let target = '(未指定)';
	let portNum = 0;

	if (port !== null) {
		target = `:${port}`;
		portNum = Number(port);
	} else if (url !== null) {
		// スキームは落として host:port だけ出す
		target = url.replace(/^[a-z]+:\/\//i, '').replace(/\/+$/, '');
		const m = /:(\d+)/.exec(target);
		portNum = m ? Number(m[1]) : 0;
	}

	return { target, rooms, port: portNum };
}

/**
 * 待受けの実体になる実行体。拡張子と大小は見ない。
 *
 * 新しい実行体が増えたらここへ足す。足し忘れても本数が少なく見えるだけで、
 * 二重に数えて「張らなくてよい」と読み違える向きには外れない。
 * Rust 版（waiters.rs の is_waiter_runtime）も同じ並びにする。
 */
export const WAITER_RUNTIMES = ['aichat', 'aichat-rs', 'node', 'bun'];

/** @param {string} name */
export function isWaiterRuntime(name) {
	return WAITER_RUNTIMES.includes((name ?? '').toLowerCase().replace(/\.exe$/, ''));
}

/** 張り方の名前。出力に出るのは aichat / aichat-rs / aichat-node / node / bun */
export function viaOf(name, parentName) {
	const lower = (name ?? '').toLowerCase();
	if (lower === 'aichat.exe') return 'aichat';
	if (lower === 'node.exe') return (parentName ?? '').toLowerCase() === 'cmd.exe' ? 'aichat-node' : 'node';
	return lower.replace(/\.exe$/, '');
}

/**
 * 一覧から待受けだけを選ぶ。
 *
 * 引数で渡した pid（自分と、一覧を取るために起こした子）は最初に外す。
 * テストから直に呼べるよう、プロセスを触る部分と分けてある。
 *
 * @param {{pid: number, ppid: number, name: string, cmd?: string, at: string}[]} rows
 * @param {number[]} excludePids
 * @param {string} defaultRoom
 */
export function pickWaiters(rows, excludePids, defaultRoom) {
	const skip = new Set(excludePids);
	const re = new RegExp(WAITER_PATTERN);

	const hits = [];
	for (const r of rows) {
		if (skip.has(r.pid)) continue;
		const m = re.exec(r.cmd ?? '');
		if (!m) continue;
		hits.push({
			pid: r.pid,
			ppid: r.ppid,
			name: r.name,
			at: r.at,
			id: m[1] ?? m[2],
			...targetOf(r.cmd ?? '', defaultRoom),
		});
	}

	/*
	 * 末端に数えるのは待受けの実体だけ。bash ・ timeout ・ pwsh のようなラッパーは数えない。
	 *
	 * 親を落とす方式だけでは、親子がつながらないラッパーを落とせない。timeout 越しに
	 * 起動すると外側の timeout.exe の親が先に終わり、ハーネスが起こした bash から
	 * 親子が切れる。bash は「子を持たない末端」として残り、同じ ID が 2 本に見えた
	 * （i261004-01。ルーム名も bash -c の引用符を拾って public' に壊れる）。
	 *
	 * ラッパーも親の判定と張り方の判定には使い続ける（cmd.exe 越しの node は aichat-node）。
	 */
	const parents = new Set(hits.map((h) => h.ppid));
	const leaves = hits.filter((h) => isWaiterRuntime(h.name) && !parents.has(h.pid));

	const nameOf = new Map(hits.map((h) => [h.pid, h.name]));
	for (const h of leaves) h.via = viaOf(h.name, nameOf.get(h.ppid));

	return leaves.sort((a, b) => (a.at === b.at ? a.pid - b.pid : a.at < b.at ? -1 : 1));
}

/**
 * 残すものと止めてよいものに分ける。
 *
 * 止めてよいのは、覆っている全ルームが他の待受けでも覆われているものだけ。
 *
 * 「2 本目以降を止める」にすると、そのルームを覆う唯一の 1 本まで名指しする。
 * 言われたとおり止めれば覆えなくなり、張り直す → また二重、を往復する。
 *
 * 判定に入れるのは基準（-r で渡したルーム）に触れる待受けだけ。基準を見ずに
 * 全部を並べると、渡していないルームの pid を止めろと出る。
 *
 * 止めてよいかは、その待受けが見ている全ルームで見る。基準の中だけで見ると、
 * 基準の外を覆っている側まで止めろと言うことになる。数ではなく中身を見るので、
 * 外の数が同じでも持っているルームが違えば両方が残る。
 *
 * 並びは基準の外を多く持つものを先に。止められるものをより多く見つけられる。
 * 古い順は、基準の外の数が同じときの決め方として残す。
 *
 * 形を @typedef に出しているのは、同じものが 3 か所（mine ・ keep ・ stop）に出るため。
 * 戻り値だけ object[] と書いていたときは、受け取った側で .pid も .rooms も引けず、
 * tsc が 3 件のエラーを出した（i260912-02 を入れて初めて見えた）。
 *
 * @typedef {{pid: number, rooms: string[], at: string}} Waiter
 *
 * @param {Waiter[]} mine 自分の待受け
 * @param {{rooms: string[]}} basis -r で渡したルーム
 * @returns {{keep: Waiter[], stop: Waiter[]}} 残すものと止めてよいもの
 */
export function splitRedundant(mine, basis) {
	const basisRooms = new Set(basis.rooms);
	const outsideCount = (h) => h.rooms.filter((room) => !basisRooms.has(room)).length;
	const order = mine
		.filter((h) => h.rooms.some((room) => basisRooms.has(room)))
		.sort((a, b) => outsideCount(b) - outsideCount(a) || (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
	const keep = [];
	const stop = [];
	const held = new Set();
	for (const h of order) {
		if (h.rooms.every((room) => held.has(room))) {
			stop.push(h);
			continue;
		}
		keep.push(h);
		for (const room of h.rooms) held.add(room);
	}
	return { keep, stop };
}
