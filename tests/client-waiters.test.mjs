/*
 * waiters（走っている待受けを数える）を確かめる。
 *
 * このコマンドは、各プロジェクトに検索式を書かせるのをやめるために作った。
 * 書き方を 1 つ守れなかっただけで結果が反転し、そのたびに事故になっていた。
 *
 *   -c で絞らない        他プロジェクトの待受けまで数え、止めてしまう（i260901-07）
 *   プロセス名で絞る      張り方によって aichat.exe / cmd.exe / node.exe に変わる
 *   ID を直に書く        確認コマンド自身に一致し、0 本が 1 本に見える
 *   前方一致             project-a を探すと project-aa にも当たる
 *
 * 4 つとも「式を人に書かせている」ことが原因なので、選び方そのものを検査する。
 * 実際にプロセスを立てるのではなく、コマンドラインの一覧を組み立てて渡す。
 * 立てると本数が実行環境に左右され、何度実行しても同じ結果にならない。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { WAITER_PATTERN, ID_WRAP } from '../src/client/options.mjs';
/*
 * 選び方は本体と同じものを使う。写しを検査すると、本体を壊しても通ってしまう。
 * ここで実物を落とせるのは、chat.mjs から純粋な関数として出したためである。
 */
/*
 * 読み取りも本体から取る。
 *
 * 以前は readArg / roomsFrom をこのファイルに写していたため、chat.mjs 側を
 * 壊してもテストは緑のままだった（レビュー #21 medium 8）。実際に readArg が
 * ダブルクォート付きの -r を読めない穴（#22 medium 7）は、写しを検査していた
 * 間ずっと見えていなかった。
 */
import { splitRedundant, readArg, roomsFrom as roomsFromRaw } from '../src/client/waiters-pick.mjs';
import { DEFAULT_ROOM, PORT } from '../src/server/config.mjs';

/** 一覧の 1 行を作る */
function proc(pid, ppid, name, cmd, at = '2026-09-03 07:00:00') {
	return { pid, ppid, name, cmd, at };
}

/** 既定のルームを埋めた形で使う（本体の chat.mjs も同じ渡し方をする） */
function roomsFrom(value) {
	return roomsFromRaw(value, DEFAULT_ROOM);
}

function targetOf(cmd) {
	const port = readArg(cmd, 'port', 'p');
	const url = readArg(cmd, 'url', 'u');
	const rooms = roomsFrom(readArg(cmd, 'room', 'r'));

	let target = '(未指定)';
	let portNum = 0;

	if (port !== null) {
		target = `:${port}`;
		portNum = Number(port);
	} else if (url !== null) {
		target = url.replace(/^[a-z]+:\/\//i, '').replace(/\/+$/, '');
		const m = /:(\d+)/.exec(target);
		portNum = m ? Number(m[1]) : 0;
	}

	return { target, rooms, port: portNum };
}

/** 表に出すかどうか。接続先で見る。ルームは列に出すので絞りに使わない */
function isHere(t, basis) {
	return t.port === basis.port;
}

/** 渡したルームのうち、覆えていないもの */
function missingRooms(mine, basis) {
	const covered = new Set();
	for (const t of mine) for (const room of t.rooms) covered.add(room);
	return basis.rooms.filter((room) => !covered.has(room));
}

/** pid・見ているルーム・いつからを持つ 1 本 */
function waiter(pid, rooms, at) {
	return { pid, rooms, at };
}

/** 既定の基準（本番の既定ルーム） */
const PROD = { port: PORT, rooms: [DEFAULT_ROOM] };

/*
 * chat.mjs の pickWaiters と同じ選び方をここに置く。
 *
 * chat.mjs はトップレベルでコマンドを走らせる作りなので import できない。
 * 写しになるのは避けたいが、選び方は事故の核なので検査は外せない。
 * 出どころの式（WAITER_PATTERN）は import しているので、そこはずれない。
 */
function pickWaiters(rows, excludePids) {
	const skip = new Set(excludePids);
	const re = new RegExp(WAITER_PATTERN);

	const hits = [];
	for (const r of rows) {
		if (skip.has(r.pid)) continue;
		const m = re.exec(r.cmd ?? '');
		if (!m) continue;
		hits.push({ pid: r.pid, ppid: r.ppid, name: r.name, at: r.at, id: m[1] ?? m[2] });
	}

	const parents = new Set(hits.map((h) => h.ppid));
	return hits.filter((h) => !parents.has(h.pid));
}

describe('待受けの見つけ方', () => {
	test('新しい形（コロンで囲んだ ID）を拾う', () => {
		const rows = [proc(100, 1, 'aichat.exe', 'aichat.exe wait :project-a: -p 8787')];
		const found = pickWaiters(rows, []);

		assert.equal(found.length, 1);
		assert.equal(found[0].id, 'project-a');
	});

	test('古い形（-c / --connector-id）も拾う', () => {
		/*
		 * 切り替えの途中は新旧が混ざる。片方しか見ないと相手の待受けを
		 * 見落とし、二重に張らせてしまう。
		 */
		const rows = [
			proc(100, 1, 'aichat.exe', 'aichat.exe wait -c project-a -p 8787'),
			proc(101, 1, 'aichat.exe', 'aichat.exe wait --connector-id project-b -p 8787'),
		];
		const found = pickWaiters(rows, []);

		assert.deepEqual(
			found.map((h) => h.id),
			['project-a', 'project-b']
		);
	});

	test('待受け以外は拾わない', () => {
		// say や who は数えない。数えるのは張っているものだけ
		const rows = [
			proc(100, 1, 'aichat.exe', 'aichat.exe say :project-a: "本文" -p 8787'),
			proc(101, 1, 'aichat.exe', 'aichat.exe who -p 8787'),
			proc(102, 1, 'aichat.exe', 'aichat.exe recent -n 5 -p 8787'),
		];

		assert.equal(pickWaiters(rows, []).length, 0);
	});

	test('waiters 自身を待受けと数えない', () => {
		/*
		 * waiters は wait で始まる。式が wait の後ろに空白を要求していないと、
		 * 数えているコマンドが数に入り、0 本が 1 本に見える。
		 */
		const rows = [proc(100, 1, 'aichat.exe', 'aichat.exe waiters :project-a:')];

		assert.equal(pickWaiters(rows, []).length, 0, 'waiters を数えている');
	});
});

describe('自分自身を数えない', () => {
	test('渡した pid は外す', () => {
		const rows = [
			proc(100, 1, 'aichat.exe', 'aichat.exe waiters :project-a:'),
			proc(200, 1, 'aichat.exe', 'aichat.exe wait :project-a: -p 8787'),
		];

		const found = pickWaiters(rows, [100]);
		assert.equal(found.length, 1);
		assert.equal(found[0].pid, 200);
	});

	test('親を落として 1 本に数える（aichat）', () => {
		/*
		 * サブエージェントは pwsh 越しに呼ぶ。pwsh のコマンドラインにも
		 * 「aichat wait :id:」がそのまま入っているので、放っておくと 2 本に見える。
		 */
		const rows = [
			proc(100, 1, 'pwsh.exe', 'pwsh.exe -Command "aichat wait :project-a: -p 8787"'),
			proc(200, 100, 'aichat.exe', 'aichat.exe wait :project-a: -p 8787'),
		];

		const found = pickWaiters(rows, []);
		assert.equal(found.length, 1, '1 本が 2 本に見えている');
		assert.equal(found[0].pid, 200, '末端ではなく親を残している');
	});

	test('3 段でも 1 本に数える（aichat-node）', () => {
		// aichat-node は cmd.exe → node.exe と 2 段になる。pwsh を足すと 3 段
		const rows = [
			proc(100, 1, 'pwsh.exe', 'pwsh.exe -Command "aichat-node wait :project-a: -p 8787"'),
			proc(200, 100, 'cmd.exe', 'cmd.exe /c aichat-node wait :project-a: -p 8787'),
			proc(300, 200, 'node.exe', 'node.exe C:/work/ai-chat-lite/src/client/chat.mjs wait :project-a: -p 8787'),
		];

		const found = pickWaiters(rows, []);
		assert.equal(found.length, 1, '1 本が 3 本に見えている');
		assert.equal(found[0].pid, 300);
	});

	test('別々の待受けは別々に数える', () => {
		// 親子でなければまとめない。2 本張っていれば 2 本と出す
		const rows = [
			proc(100, 1, 'aichat.exe', 'aichat.exe wait :project-a: -p 8787'),
			proc(200, 1, 'aichat.exe', 'aichat.exe wait :project-a: -p 8787'),
		];

		assert.equal(pickWaiters(rows, []).length, 2, '二重を見逃している');
	});
});

describe('前方一致する ID を取り違えない', () => {
	test('project-a を数えても project-aa と project-a-b が混ざらない', () => {
		/*
		 * 囲みが無いと当たってしまう組み合わせ。ここが事故の元だった。
		 * project-aa は \b でも防げるが、project-a-b は防げない（- が語の境目）。
		 */
		const rows = [
			proc(100, 1, 'aichat.exe', 'aichat.exe wait :project-a: -p 8787'),
			proc(200, 1, 'aichat.exe', 'aichat.exe wait :project-aa: -p 8787'),
			proc(300, 1, 'aichat.exe', 'aichat.exe wait :project-a-b: -p 8787'),
		];

		const found = pickWaiters(rows, []);
		assert.equal(found.length, 3);

		const mine = found.filter((h) => h.id === 'project-a');
		assert.equal(mine.length, 1, 'project-a の本数が合わない');
		assert.equal(mine[0].pid, 100);
	});

	test('ID は囲みの中だけを取る', () => {
		// 囲みごと ID に含めてしまうと、DB へ送る値が変わってしまう
		const rows = [proc(100, 1, 'aichat.exe', `aichat.exe wait ${ID_WRAP}project-a${ID_WRAP} -p 8787`)];
		const found = pickWaiters(rows, []);

		assert.equal(found[0].id, 'project-a');
		assert.ok(!found[0].id.includes(ID_WRAP), '囲みが ID に混ざっている');
	});
});

describe('張り方を問わず拾える', () => {
	test('3 通りの張り方すべてを数える', () => {
		/*
		 * プロセス名で絞ると、どれかが漏れる。式はコマンドラインだけを見る。
		 * 従来の直呼び（node .../chat.mjs）も拾えることが要点。
		 * 検索式ではこれが拾えず、取りこぼしていた。
		 */
		const rows = [
			proc(100, 1, 'aichat.exe', 'aichat.exe wait :project-a: -p 8787'),
			proc(200, 1, 'cmd.exe', 'cmd.exe /c aichat-node wait :project-b: -p 8787'),
			proc(300, 200, 'node.exe', 'node.exe .../chat.mjs wait :project-b: -p 8787'),
			proc(400, 1, 'node.exe', 'node.exe C:/work/ai-chat-lite/src/client/chat.mjs wait :project-c: -p 8787'),
		];

		const found = pickWaiters(rows, []);
		assert.deepEqual(
			found.map((h) => h.id).sort(),
			['project-a', 'project-b', 'project-c']
		);
	});
});

describe('どこを待っているかを読む', () => {
	test('ポートとルームを読む', () => {
		const t = targetOf('aichat.exe wait :project-a: -p 8787 -r dev');

		assert.equal(t.target, ':8787');
		assert.deepEqual(t.rooms, ['dev']);
	});

	test('ルームを書かなければ既定のルーム', () => {
		const t = targetOf('aichat.exe wait :project-a: -p 8787');

		assert.deepEqual(t.rooms, [DEFAULT_ROOM]);
	});

	test('長い形でも読む', () => {
		const t = targetOf('aichat.exe wait :project-a: --port 8787 --room dev');

		assert.equal(t.target, ':8787');
		assert.deepEqual(t.rooms, ['dev']);
	});

	test('--url からはホストとポートを取り、スキームは落とす', () => {
		const t = targetOf('node chat.mjs wait :project-a: --url http://127.0.0.1:49406/');

		assert.equal(t.target, '127.0.0.1:49406');
	});

	test('接続先を書いていなければ (未指定) と出す', () => {
		// 実際には繋ぐ前に止まるが、読めないものを空欄にはしない
		const t = targetOf('aichat.exe wait :project-a:');

		assert.equal(t.target, '(未指定)');
	});
});

describe('基準に合う待受けだけを数える', () => {
	/*
	 * ここが要点。本数だけでは足りない。
	 *
	 * ポートを間違えれば繋がらないか別のサーバーに繋がるので、まだ気づける。
	 * ルームを間違えると繋がったまま静かに動く。who は「接続中」と出し、
	 * waiters も 1 本と数えるが、その場所の発言は 1 つも届かない。
	 * どこも異常に見えないのに、発言だけが届かない。
	 */
	test('本番のポートと既定のルームなら本番の分と数える', () => {
		assert.equal(isHere(targetOf(`aichat.exe wait :project-a: -p ${PORT}`), PROD), true);
	});

	test('ポートが違えば本番の分ではない', () => {
		assert.equal(isHere(targetOf('aichat.exe wait :project-a: -p 49999'), PROD), false);
	});

	test('ルームが違っても表には出す。覆えていないことは別に見る', () => {
		/*
		 * 1 本が複数のルームを見られるので、ルームで表から外すと読めなくなる。
		 * 表には出したうえで、渡したルームが覆えているかを別に数える。
		 */
		const t = targetOf(`aichat.exe wait :project-a: -p ${PORT} -r dev`);

		assert.equal(isHere(t, PROD), true, '同じ接続先なのに表から外している');
		assert.deepEqual(missingRooms([t], PROD), [DEFAULT_ROOM], '覆えていないことを見落としている');
	});

	test('--url で本番のポートを指していれば本番の分と数える', () => {
		assert.equal(isHere(targetOf(`aichat.exe wait :project-a: -u http://localhost:${PORT}`), PROD), true);
	});

	test('基準を変えればテスト用サーバーの分を数えられる', () => {
		/*
		 * 基準を固定にすると、テスト環境では「全部が本番以外」に見えて使えない。
		 * 数える側が --port / --url / --room で基準を渡す。
		 */
		const t = targetOf('node chat.mjs wait :project-a: --url http://127.0.0.1:49406');

		assert.equal(isHere(t, PROD), false, '本番の分として数えている');
		assert.equal(isHere(t, { port: 49406, room: DEFAULT_ROOM }), true, 'テスト用の基準で数えられない');
	});

	test('テスト用サーバーに向いた 1 本を「本番に張っている」と数えない', () => {
		/*
		 * これを混ぜて数えると、「張っているから張らない」と判断して
		 * 本番の待受けが 1 本も無いまま止まる。i260903-02 で直したのと同じ失敗の形。
		 */
		const rows = [
			proc(100, 1, 'node.exe', 'node chat.mjs wait :project-a: --url http://127.0.0.1:49406'),
			proc(200, 1, 'aichat.exe', `aichat.exe wait :project-b: -p ${PORT}`),
		];

		const found = pickWaiters(rows, []).map((h) => ({ ...h, ...targetOf(rows.find((r) => r.pid === h.pid).cmd) }));

		assert.equal(found.length, 2, '本数は 2 本');
		assert.equal(found.filter((h) => h.id === 'project-a' && isHere(h, PROD)).length, 0, '本番として数えている');
		assert.equal(found.filter((h) => h.id === 'project-b' && isHere(h, PROD)).length, 1);
	});

	test('自分の分が別の場所にあることは pid で分かる', () => {
		/*
		 * 件数だけでは止めようがない。自分の分は pid まで出す。
		 * 他プロジェクトの分は件数だけにする（止めてはいけないため）。
		 */
		const rows = [proc(100, 1, 'aichat.exe', 'aichat.exe wait :project-a: -p 49999 -r dev')];
		const found = pickWaiters(rows, []).map((h) => ({ ...h, ...targetOf(rows[0].cmd) }));

		const stray = found.filter((h) => h.id === 'project-a' && !isHere(h, PROD));
		assert.equal(stray.length, 1);
		assert.equal(stray[0].pid, 100, 'pid が取れていない');
		assert.deepEqual(stray[0].rooms, ['dev'], 'どのルームを見ているか分からない');
	});
});

describe('覆えているかで見る', () => {
	/*
	 * 1 本が複数のルームを見られるので、「2 ルームなら 2 本」は成り立たない。
	 * 本数ではなく、渡したルームが 1 つでも欠けていないかで判断する。
	 */
	const BOTH = { port: PORT, rooms: ['public', 'ai-chat-lite'] };

	test('1 本で 2 つとも見ていれば足りている', () => {
		const t = targetOf(`aichat.exe wait :project-a: -p ${PORT} -r public,ai-chat-lite`);

		assert.deepEqual(missingRooms([t], BOTH), []);
	});

	test('2 本で 1 つずつ見ていても足りている', () => {
		const a = targetOf(`aichat.exe wait :project-a: -p ${PORT} -r public`);
		const b = targetOf(`aichat.exe wait :project-a: -p ${PORT} -r ai-chat-lite`);

		assert.deepEqual(missingRooms([a, b], BOTH), []);
	});

	test('欠けているルームだけを名指しする', () => {
		// 「1 本足りません」では、どれを張ればよいか読み手が考えることになる
		const t = targetOf(`aichat.exe wait :project-a: -p ${PORT} -r public`);

		assert.deepEqual(missingRooms([t], BOTH), ['ai-chat-lite']);
	});

	test('1 本も無ければ全部が欠けている', () => {
		assert.deepEqual(missingRooms([], BOTH), ['public', 'ai-chat-lite']);
	});

	test('渡していないルームを見ていても足しにはならない', () => {
		const t = targetOf(`aichat.exe wait :project-a: -p ${PORT} -r dev`);

		assert.deepEqual(missingRooms([t], BOTH), ['public', 'ai-chat-lite']);
	});

	test('同じルームを 2 回書いても 1 つとして数える', () => {
		const t = targetOf(`aichat.exe wait :project-a: -p ${PORT} -r public,public`);

		assert.deepEqual(t.rooms, ['public']);
	});

	test('区切りの前後の空白は落とす', () => {
		/*
		 * 人が書くので、カンマの後ろに空白が入ることがある。
		 * ただしコマンドラインから読むほうは空白で切れるため、ここに空白は来ない。
		 * 空白が来るのは自分の -r（引用符で囲んで渡された値）を割るときである。
		 */
		assert.deepEqual(roomsFrom('public, ai-chat-lite'), ['public', 'ai-chat-lite']);
		assert.deepEqual(roomsFrom('  public ,  dev  '), ['public', 'dev']);
	});
});

describe('止めてよいのはどれか', () => {
	/** 2 ルームを渡したときの基準 */
	const BOTH = { port: PORT, rooms: ['public', 'ai-chat-lite'] };

	/*
	 * 【なぜ必要か】
	 * 「2 本目以降を止める」にすると、そのルームを覆う唯一の 1 本まで名指しする。
	 * 言われたとおり止めれば覆えなくなり、張り直す → また二重、を往復する。
	 * 同じ節が防ごうとしていた i260901-07 と同じ形の事故になる。
	 */
	test('唯一の 1 本は止めない', () => {
		const rows = [
			waiter(100, ['public'], '2026-09-07 10:00:00'),
			waiter(200, ['ai-chat-lite'], '2026-09-07 10:01:00'),
			waiter(300, ['public'], '2026-09-07 10:02:00'),
		];

		const { keep, stop } = splitRedundant(rows, BOTH);

		assert.deepEqual(
			stop.map((h) => h.pid),
			[300],
			'唯一の 1 本まで止めようとしている'
		);
		assert.deepEqual(
			keep.map((h) => h.pid),
			[100, 200]
		);
	});

	test('止めたあとも全部が覆えている', () => {
		// 止める判断そのものより、止めた結果が壊れていないことが要点
		const rows = [
			waiter(100, ['public', 'ai-chat-lite'], '2026-09-07 10:00:00'),
			waiter(200, ['public'], '2026-09-07 10:01:00'),
			waiter(300, ['ai-chat-lite'], '2026-09-07 10:02:00'),
		];

		const { keep, stop } = splitRedundant(rows, BOTH);
		const covered = new Set(keep.flatMap((h) => h.rooms));

		assert.deepEqual(
			stop.map((h) => h.pid),
			[200, 300]
		);
		assert.ok(covered.has('public') && covered.has('ai-chat-lite'), '覆えなくなっている');
	});

	test('余りが無ければ 1 本も止めない', () => {
		const rows = [
			waiter(100, ['public'], '2026-09-07 10:00:00'),
			waiter(200, ['ai-chat-lite'], '2026-09-07 10:01:00'),
		];

		assert.deepEqual(splitRedundant(rows, BOTH).stop, []);
	});

	test('古いほうを残す', () => {
		// 読み位置はサーバーが覚えているので、どちらを残しても取りこぼさない。
		// 経過の長いほうを残すと、次に刈られるまでの間隔が読みやすい
		const rows = [
			waiter(300, ['public'], '2026-09-07 10:02:00'),
			waiter(100, ['public'], '2026-09-07 10:00:00'),
		];

		const { keep, stop } = splitRedundant(rows, PROD);

		assert.deepEqual(keep.map((h) => h.pid), [100]);
		assert.deepEqual(stop.map((h) => h.pid), [300]);
	});

	/*
	 * 【なぜ必要か】
	 * 覆いの判定に待受けの全ルームを入れると、渡したルームが二重でも
	 * 「すべて覆えています」と出る。逆に、渡していないルームについて
	 * 「pid を止めろ」とも出る。どちらも基準を渡した意味が効いていない形。
	 */
	test('渡したルームの二重は、基準の外も見ている分を残す', () => {
		// 100 を止めれば dev の覆いは残る。200 を止めると dev が消える
		const rows = [
			waiter(100, ['public'], '2026-09-07 10:00:00'),
			waiter(200, ['public', 'dev'], '2026-09-07 10:01:00'),
		];

		const { keep, stop } = splitRedundant(rows, PROD);

		assert.deepEqual(stop.map((h) => h.pid), [100], '基準の外の覆いが消える側を止めようとしている');
		assert.deepEqual(keep.map((h) => h.pid), [200]);
	});

	test('基準の外だけを見ている分は判定に入らない', () => {
		// public を数えたつもりで dev の指示が返ってはいけない
		const rows = [
			waiter(100, ['public', 'dev'], '2026-09-07 10:00:00'),
			waiter(200, ['dev'], '2026-09-07 10:01:00'),
		];

		const { keep, stop } = splitRedundant(rows, PROD);

		assert.deepEqual(stop, [], '渡していないルームの pid を止めろと出ている');
		assert.deepEqual(keep.map((h) => h.pid), [100]);
	});

	/*
	 * 【なぜ必要か】
	 * 基準の外を「数」で見ていた頃は、外が 1 対 1 で中身が違う形を取り違えた。
	 * 数が同じなら古い順で決まるため、後の 1 本だけが持つ外のルームが消える。
	 * 「止めろと言った pid を止めれば必ず覆いが保たれる」を崩す形になる。
	 */
	test('基準の外の数が同じで中身が違うなら、どちらも止めない', () => {
		// devA と devB は互いに覆っていない。止めればどちらかが消える
		const rows = [
			waiter(100, ['public', 'devA'], '2026-09-07 10:00:00'),
			waiter(200, ['public', 'devB'], '2026-09-07 10:01:00'),
		];

		const { keep, stop } = splitRedundant(rows, PROD);

		assert.deepEqual(stop, [], '基準の外の覆いが消える側を止めようとしている');
		assert.deepEqual(keep.map((h) => h.pid), [100, 200]);
	});

	test('基準の外を多く持つ側があっても、少ない側だけが持つルームは守る', () => {
		// 200 を止めると devC が消える。外の数だけで残す側を決めてはいけない
		const rows = [
			waiter(100, ['public', 'devA', 'devB'], '2026-09-07 10:00:00'),
			waiter(200, ['public', 'devC'], '2026-09-07 10:01:00'),
		];

		const { keep, stop } = splitRedundant(rows, PROD);

		assert.deepEqual(stop, [], '外の数が多い側を残せば足りると見なしている');
		assert.deepEqual(keep.map((h) => h.pid), [100, 200]);
	});

	test('足りないことと余っていることは同時に起こる', () => {
		/*
		 * 片方で打ち切ると、もう片方が隠れる。隠すと、張る → 二重、の往復になる。
		 */
		const basis = { port: PORT, rooms: ['public', 'ai-chat-lite'] };
		const rows = [
			waiter(100, ['public'], '2026-09-07 10:00:00'),
			waiter(300, ['public'], '2026-09-07 10:02:00'),
		];

		assert.deepEqual(missingRooms(rows, basis), ['ai-chat-lite'], '足りないルームが出ていない');
		assert.deepEqual(splitRedundant(rows, basis).stop.map((h) => h.pid), [300], '余っている分が出ていない');
	});
});

describe('接続先は省略できない', () => {
	/*
	 * 他のコマンドと同じ扱いにする。既定を本番にすると、テストのつもりで
	 * 数えたものが本番の本数として返る。「張っているから張らない」と判断して
	 * 本番の待受けが 1 本も無いまま止まる。書き込まないだけで、事故の形は同じ。
	 */
	test('渡さなければ終了コード 2 で止まる', async () => {
		const { execFile } = await import('node:child_process');
		const { promisify } = await import('node:util');
		const { fileURLToPath } = await import('node:url');
		const { dirname, join } = await import('node:path');

		const run = promisify(execFile);
		const client = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client', 'chat.mjs');

		try {
			await run(process.execPath, [client, 'waiters', ':test-basis:'], { env: { ...process.env } });
			assert.fail('エラーにならなかった');
		} catch (err) {
			assert.equal(err.code, 2);
			assert.match(err.stderr, /どこを見ている待受けを数えるかが指定されていません/);
			assert.match(err.stderr, /既定値は持ちません/);
		}
	});
});

describe('コマンドラインの読み取り', () => {
	/*
	 * 【なぜ必要か】
	 * 共通ルールと USAGE は、カンマ区切りで複数のルームを渡すときに
	 * -r "public,ai-chat-lite" とダブルクォートで囲むよう定めている。cmd 経由の
	 * ランチャーは引数を素通しするので、囲みは待受けのコマンドラインに残る。
	 *
	 * 以前の式は値から " を除いていたため、囲んで渡した待受けでは値の先頭が "
	 * で一致せず null になり、既定の public 1 つとして数えていた。**正しく
	 * 2 ルーム覆っている待受けが 1 つと数えられ**、「ai-chat-lite の待受けが
	 * ありません。張ってください」と出て、共通ルールが最も強く禁じる
	 * 「同じルームを 2 本で見ない」を道具の出力が指示する形になっていた
	 * （レビュー #22 medium 7）。
	 */
	test('ダブルクォートで囲んだ -r を読める', () => {
		const cmd = 'aichat wait :project-a: -p 8787 -r "public,ai-chat-lite"';

		assert.equal(readArg(cmd, 'room', 'r'), 'public,ai-chat-lite');
		assert.deepEqual(roomsFrom(readArg(cmd, 'room', 'r')), ['public', 'ai-chat-lite']);
	});

	test('囲まずに渡した -r も今までどおり読める', () => {
		const cmd = 'aichat wait :project-a: -p 8787 -r public';

		assert.equal(readArg(cmd, 'room', 'r'), 'public');
		assert.deepEqual(roomsFrom(readArg(cmd, 'room', 'r')), ['public']);
	});

	test('囲みの中に空白が入っていても 1 つの値として読む', () => {
		// PowerShell 側で "a, b" のように空けて書かれることがある
		const cmd = 'aichat wait :project-a: -p 8787 -r "public, ai-chat-lite" --wait-hour 12';

		assert.equal(readArg(cmd, 'room', 'r'), 'public, ai-chat-lite');
		assert.deepEqual(roomsFrom(readArg(cmd, 'room', 'r')), ['public', 'ai-chat-lite']);
	});

	test('長い形（--room）でも同じ', () => {
		const cmd = 'aichat wait :project-a: -p 8787 --room "public,dev"';

		assert.deepEqual(roomsFrom(readArg(cmd, 'room', 'r')), ['public', 'dev']);
	});

	test('-r が無ければ既定のルーム 1 つ', () => {
		assert.deepEqual(roomsFrom(readArg('aichat wait :project-a: -p 8787', 'room', 'r')), [DEFAULT_ROOM]);
	});
});

describe('-r の値は英数字・ハイフン・下線・ピリオドだけ', () => {
	/*
	 * 【なぜ必要か】
	 * roomsFrom はカンマで分割するだけで、文字種の検証を一切していなかった。
	 * waiters はサーバーに繋がないコマンドなので、サーバー側の room_id 検証
	 * （英数字・ハイフン・下線・ピリオドのみ）を経由できない。シングルクォートで
	 * 囲んで渡すと、cmd はクォート文字を値に含めてしまう（'public,ai-chat-lite'
	 * のような壊れた値になる）が、waiters はそれをカンマで割ってそのまま
	 * 「ルーム名」として扱い、エラーにならなかった（実際に指摘があった）。
	 */
	test('不正な文字を含むと終了コード 2 で止まる', async () => {
		const { execFile } = await import('node:child_process');
		const { promisify } = await import('node:util');
		const { fileURLToPath } = await import('node:url');
		const { dirname, join } = await import('node:path');

		const run = promisify(execFile);
		const client = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client', 'chat.mjs');

		try {
			await run(
				process.execPath,
				[client, 'waiters', ':test-basis:', '-p', '8787', '-r', "'public,ai-chat-lite'"],
				{ env: { ...process.env } }
			);
			assert.fail('エラーにならなかった');
		} catch (err) {
			assert.equal(err.code, 2);
			assert.match(err.stderr, /ルーム名に使えない文字/);
		}
	});
});

describe('式の置き場', () => {
	test('式は options.mjs 1 か所から来る', () => {
		// CLI 2 本が同じ式を見る。写すと必ずずれる
		assert.match(WAITER_PATTERN, /wait/);
		assert.ok(WAITER_PATTERN.includes('\\s'), 'wait の後ろに空白を要求していない');
	});

	test('式は JavaScript の正規表現として読める', () => {
		assert.doesNotThrow(() => new RegExp(WAITER_PATTERN));
	});
});
