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
import { DEFAULT_ROOM, PORT } from '../src/server/config.mjs';

/** 一覧の 1 行を作る */
function proc(pid, ppid, name, cmd, at = '2026-09-03 07:00:00') {
	return { pid, ppid, name, cmd, at };
}

/*
 * chat.mjs の readArg / targetOf と同じ読み方をここに置く。
 * 「どこを待っているか」の判定は事故の核なので検査は外せない。
 */
function readArg(cmd, long, short) {
	const m = new RegExp(`(?:^|\\s)(?:--${long}|-${short})\\s+([^\\s"]+)`).exec(cmd);
	return m ? m[1] : null;
}

function targetOf(cmd) {
	const port = readArg(cmd, 'port', 'p');
	const url = readArg(cmd, 'url', 'u');
	const room = readArg(cmd, 'room', 'r') ?? DEFAULT_ROOM;

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

	return { target, room, port: portNum };
}

/** 基準に合うかどうか。合わない分は表に出さず、件数だけ添える */
function isHere(t, basis) {
	return t.port === basis.port && t.room === basis.room;
}

/** 既定の基準（本番の既定ルーム） */
const PROD = { port: PORT, room: DEFAULT_ROOM };

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
			proc(300, 200, 'node.exe', 'node.exe N:/2026/ai-chat-lite/src/client/chat.mjs wait :project-a: -p 8787'),
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
			proc(400, 1, 'node.exe', 'node.exe N:/2026/ai-chat-lite/src/client/chat.mjs wait :project-c: -p 8787'),
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
		assert.equal(t.room, 'dev');
	});

	test('ルームを書かなければ既定のルーム', () => {
		const t = targetOf('aichat.exe wait :project-a: -p 8787');

		assert.equal(t.room, DEFAULT_ROOM);
	});

	test('長い形でも読む', () => {
		const t = targetOf('aichat.exe wait :project-a: --port 8787 --room dev');

		assert.equal(t.target, ':8787');
		assert.equal(t.room, 'dev');
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

	test('ルームが違えば本番の分ではない', () => {
		// 静かに壊れる方。ポート違いより見つけにくい
		assert.equal(isHere(targetOf(`aichat.exe wait :project-a: -p ${PORT} -r dev`), PROD), false);
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
		const rows = [proc(100, 1, 'aichat.exe', `aichat.exe wait :project-a: -p ${PORT} -r dev`)];
		const found = pickWaiters(rows, []).map((h) => ({ ...h, ...targetOf(rows[0].cmd) }));

		const stray = found.filter((h) => h.id === 'project-a' && !isHere(h, PROD));
		assert.equal(stray.length, 1);
		assert.equal(stray[0].pid, 100, 'pid が取れていない');
		assert.equal(stray[0].room, 'dev', 'どのルームを見ているか分からない');
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
