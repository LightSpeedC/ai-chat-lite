/*
 * unwait (待受けを止める)と、サーバを落とす shutdown・廃止した stop を確かめる。
 *
 * 【なぜ作ったか】
 * 待受けを止めたつもりで、サーバを落とす `aichat stop` を思い浮かべる取り違えが起きた。
 * サーバを落とすほうの名前を shutdown に変え、待受けを止める口を aichat の中に作る
 * (i261115-01。決定 35-A ・ 36-A ・ 37-A)。
 *
 * 止める相手を間違えると、他プロジェクトの待受けが原因不明の exit 255 で落ちる
 * (i260901-07)。そのため「止めるもの」の選び方は純粋な関数に出して、実物で確かめる。
 * 止めた結果の表示と終了コードは、実際にプロセスを立てて確かめる。
 *
 * 【終了コード】正常 (0) は「最初からいない」と「止められた」だけ。止められなかった・
 * 残っている・止めていない (接続先かルームが違う自分の待受け)は異常 (1)。利用者の指示。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { planUnwait, unwaitExitCode } from '../src/client/waiters-pick.mjs';
import { COMMANDS, ADMIN_COMMANDS, REMOVED_COMMANDS } from '../src/client/options.mjs';

const run = promisify(execFile);
const CLIENT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client', 'chat.mjs');

/** 実行して、失敗しても終了コードと出力を返す */
async function chat(args) {
	try {
		const out = await run(process.execPath, [CLIENT, ...args], { env: { ...process.env } });
		return { code: 0, stdout: out.stdout, stderr: out.stderr };
	} catch (err) {
		return { code: err.code, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
	}
}

/** pickWaiters が返す形の 1 本 */
function w(pid, id, port, rooms) {
	return { pid, ppid: 1, name: 'aichat.exe', at: '2026-11-15 10:00:00', id, port, target: `:${port}`, rooms, via: 'aichat' };
}

const BASIS = { port: 8787, rooms: ['public'] };

describe('止める相手の選び方 (planUnwait)', () => {
	test('自分の ID で、接続先とルームが完全に一致した分だけが対象になる', () => {
		const found = [w(100, 'me', 8787, ['public']), w(200, 'me', 8787, ['public'])];

		const plan = planUnwait(found, 'me', BASIS);

		assert.deepEqual(plan.targets.map((h) => h.pid), [100, 200]);
		assert.deepEqual(plan.strays, []);
	});

	test('他の ID の待受けは対象にせず、件数だけを数える', () => {
		// 他プロジェクトの分を止めると、相手は原因不明の exit 255 で落ちる
		const found = [w(100, 'me', 8787, ['public']), w(300, 'other', 8787, ['public']), w(301, 'other-2', 8787, ['public'])];

		const plan = planUnwait(found, 'me', BASIS);

		assert.deepEqual(plan.targets.map((h) => h.pid), [100]);
		assert.equal(plan.others, 2);
	});

	test('前方一致する ID を取り違えない (me と me-2)', () => {
		const found = [w(100, 'me', 8787, ['public']), w(200, 'me-2', 8787, ['public'])];

		assert.deepEqual(planUnwait(found, 'me', BASIS).targets.map((h) => h.pid), [100]);
	});

	test('ルームが違う分は止めず、理由を添えて「止めていない」に出す (37-A)', () => {
		const found = [w(100, 'me', 8787, ['dev'])];

		const plan = planUnwait(found, 'me', BASIS);

		assert.deepEqual(plan.targets, []);
		assert.equal(plan.strays.length, 1);
		assert.equal(plan.strays[0].pid, 100);
		assert.match(plan.strays[0].reason, /ルームが違う/);
	});

	test('渡したルームを含むだけの待受け (public,dev) は止めない', () => {
		// 完全一致だけ。他のルームの通知まで巻き込んで切らない
		const found = [w(100, 'me', 8787, ['public', 'dev'])];

		const plan = planUnwait(found, 'me', BASIS);

		assert.deepEqual(plan.targets, [], '含むだけの待受けを止めようとしている');
		assert.equal(plan.strays[0].pid, 100);
	});

	test('ルームの並びが違っても、同じ集合なら一致とみなす', () => {
		const found = [w(100, 'me', 8787, ['dev', 'public'])];

		const plan = planUnwait(found, 'me', { port: 8787, rooms: ['public', 'dev'] });

		assert.deepEqual(plan.targets.map((h) => h.pid), [100]);
	});

	test('接続先が違う分は止めず、理由を添えて「止めていない」に出す', () => {
		const found = [w(100, 'me', 49999, ['public'])];

		const plan = planUnwait(found, 'me', BASIS);

		assert.deepEqual(plan.targets, []);
		assert.match(plan.strays[0].reason, /別の場所/);
	});
});

describe('終了コード (unwaitExitCode)', () => {
	/*
	 * 正常 (0) は 2 つだけ。「最初からいない」と「止められた」。それ以外は異常 (1)。
	 * 第 2 引数は「止めていない」自分の待受けの本数 (接続先かルームが違う分)。
	 */
	test('止められたときは 0', () => {
		assert.equal(unwaitExitCode(['止めた', '止めた'], 0), 0);
	});

	test('最初からいないときは 0', () => {
		// 止める待受けも、止めていない待受けも無い。望んだ状態に、もうなっている
		assert.equal(unwaitExitCode([], 0), 0);
	});

	test('止められなかった分が 1 本でもあれば 1', () => {
		assert.equal(unwaitExitCode(['止めた', '止められなかった'], 0), 1);
	});

	test('残っている分が 1 本でもあれば 1', () => {
		assert.equal(unwaitExitCode(['止めた', '残っている'], 0), 1);
	});

	test('止めていない分があれば、止めた分があっても 1', () => {
		// 自分の待受けがまだ別の場所で走っている。止めたつもりにさせない
		assert.equal(unwaitExitCode(['止めた'], 1), 1);
	});

	test('対象が無くても、止めていない分があれば 1', () => {
		assert.equal(unwaitExitCode([], 1), 1);
	});
});

describe('定義', () => {
	test('stop は廃止したコマンドとして案内だけを持ち、実行できるコマンドには残らない', () => {
		const names = [...COMMANDS, ...ADMIN_COMMANDS].map((c) => c.name);

		assert.ok(!names.includes('stop'), 'stop が実行できるコマンドに残っている');
		assert.ok(REMOVED_COMMANDS.has('stop'));
	});

	test('shutdown と unwait が定義されている', () => {
		const names = [...COMMANDS, ...ADMIN_COMMANDS].map((c) => c.name);

		assert.ok(names.includes('shutdown'));
		assert.ok(names.includes('unwait'));
	});

	test('unwait はサーバーに繋がないコマンド (waiters と同じ)', () => {
		assert.equal(COMMANDS.find((c) => c.name === 'unwait')?.offline, true);
	});

	test('stop の案内は unwait だけを示し、shutdown は案内しない', () => {
		// サーバを落とす案内は出さない (利用者の指示)
		const hint = REMOVED_COMMANDS.get('stop')?.hint ?? '';

		assert.match(hint, /unwait/);
		assert.ok(!/shutdown/.test(hint), 'サーバを落とす案内が混ざっている');
	});
});

describe('廃止した stop', () => {
	test('何も実行せず、unwait を案内して終了コード 2 で終わる', async () => {
		// 接続先も ID も渡さない。繋ぎに行くなら、その案内より先に別のエラーで止まる
		const r = await chat(['stop']);

		assert.equal(r.code, 2, '終了コードが 2 ではない');
		assert.match(r.stderr, /unwait/);
		assert.ok(!/shutdown/.test(r.stderr), 'サーバを落とす案内が出ている');
	});

	test('従来の形 (stop :id: -p) で呼んでも、サーバに繋がず案内で止まる', async () => {
		// 1 番ポートは誰も待っていない。繋ぎに行けば終了コード 3 になる
		const r = await chat(['stop', ':test-stop:', '-p', '1']);

		assert.equal(r.code, 2);
		assert.match(r.stderr, /unwait/);
	});
});

describe('shutdown', () => {
	test('--yes が無ければ、サーバに繋がず落とさずに終了コード 2 で止まる', async () => {
		// 1 番ポートは誰も待っていない。繋ぎに行けば終了コード 3 になる
		const r = await chat(['shutdown', ':test-shutdown:', '-p', '1']);

		assert.equal(r.code, 2, '終了コードが 2 ではない (繋ぎに行った可能性)');
		assert.match(r.stderr, /--yes/);
	});
});

describe('unwait の実機 (仮の待受けを立てて止める)', () => {
	/*
	 * 実物の待受けは立てない。待受けに見えるコマンドラインを持つだけの node を立てる。
	 * 本番のポートは使わない。ほかのテストと重ならないよう、pid からポートを決める。
	 */
	const PORT = 40000 + (process.pid % 20000);
	const ID = `test-unwait-${process.pid}`;

	/** 待受けに見える仮のプロセス。-e の後ろの引数がそのままコマンドラインに残る */
	function dummy(id, room) {
		const child = spawn(
			process.execPath,
			['-e', 'setInterval(() => {}, 1000)', 'wait', `:${id}:`, '-p', String(PORT), '-r', room],
			{ stdio: 'ignore', windowsHide: true }
		);
		return child;
	}

	function alive(pid) {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	}

	/** 一覧に出るまで待つ。起動直後は出ないことがある */
	async function settle() {
		await new Promise((resolve) => setTimeout(resolve, 1500));
	}

	test('最初からいなければ、何も止めず、無いと出して終了コード 0', async () => {
		const r = await chat(['unwait', `:${ID}-none:`, '-p', String(PORT), '-r', 'public']);

		assert.equal(r.code, 0, `最初からいないのに異常にしている\n${r.stdout}${r.stderr}`);
		assert.match(r.stdout, /止める待受けは見つかりませんでした/);
	});

	test('一致した待受けを止め、結果を表で出して終了コード 0 で終わる', async () => {
		const child = dummy(ID, 'public');
		try {
			await settle();

			const r = await chat(['unwait', `:${ID}:`, '-p', String(PORT), '-r', 'public']);

			assert.equal(r.code, 0, `終了コード ${r.code}\n${r.stdout}${r.stderr}`);
			assert.match(r.stdout, /結果/);
			assert.match(r.stdout, new RegExp(String(child.pid)));
			assert.match(r.stdout, /止めた 1 本 \/ 止められなかった 0 本 \/ 残っている 0 本 \/ 止めていない 0 本/);
			assert.equal(alive(child.pid), false, '止めたと出したのにプロセスが残っている');
		} finally {
			child.kill();
		}
	});

	test('ルームが違う待受けは止めず、止めていないと出して終了コード 1', async () => {
		const child = dummy(ID, 'dev');
		try {
			await settle();

			const r = await chat(['unwait', `:${ID}:`, '-p', String(PORT), '-r', 'public']);

			assert.equal(r.code, 1, '止めていないのに成功にしている');
			assert.match(r.stdout, /ルームが違う/);
			assert.match(r.stdout, /止めていない 1 本/);
			assert.equal(alive(child.pid), true, 'ルームが違う待受けまで止めている');
		} finally {
			child.kill();
		}
	});

	test('他の ID の待受けは止めない', async () => {
		const mine = dummy(ID, 'public');
		const other = dummy(`${ID}-other`, 'public');
		try {
			await settle();

			const r = await chat(['unwait', `:${ID}:`, '-p', String(PORT), '-r', 'public']);

			assert.equal(r.code, 0, `${r.stdout}${r.stderr}`);
			assert.equal(alive(mine.pid), false);
			assert.equal(alive(other.pid), true, '他の ID の待受けまで止めている');
		} finally {
			mine.kill();
			other.kill();
		}
	});

	test('接続先を渡さなければ、終了コード 2 で止まる (既定値を持たない)', async () => {
		const r = await chat(['unwait', `:${ID}:`]);

		assert.equal(r.code, 2);
	});
});
