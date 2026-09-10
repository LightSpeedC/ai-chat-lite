/*
 * 走っている待受けの読み取りと、残すものと止めてよいものへの分け方。
 *
 * ここに置くのは、写しにすると守れないからである。chat.mjs に書いてテストへ
 * 貼っていたときは、テストが守るのは写しだけで、本体を壊しても通ってしまった。
 * C# 版（src/cli-cs/Waiters.cs）は言語が違うので写しが残る。そちらは
 * tests/cli-cs.test.mjs が出力の書式を突き合わせて守る。
 */

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
 * @param {{pid: number, rooms: string[], at: string}[]} mine 自分の待受け
 * @param {{rooms: string[]}} basis -r で渡したルーム
 * @returns {{keep: object[], stop: object[]}} 残すものと止めてよいもの
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
