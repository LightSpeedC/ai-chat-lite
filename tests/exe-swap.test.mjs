/*
 * 走っている exe を入れ替えられることを確かめる。
 *
 * 【なぜ要るか】
 * 既定の `aichat.exe` は待受けが掴んでいる。待受けは 12 時間張りっぱなしになり、
 * 掴んでいるのは自分の分だけではない。他プロジェクトの待受けも混ざる。
 * 止めれば相手は原因不明の `exit 255` で落ちる（ローカルルール 3）。
 *
 * そこで「消さずに改名する」形を使う。Windows では走っている exe を削除できないが、
 * 名前は変えられる。改名はディレクトリの項目を書き換えるだけで、開かれている
 * 実体には触らないため、走っているプロセスは改名後の実体を使い続ける。
 *
 * この前提が崩れると、ビルドのたびに他プロジェクトを落とすことになる。
 * 理屈だけで信じず、実物の exe を走らせた状態で 1 段ずつ確かめる。
 *
 * 【Windows 専用】
 * Mac ・ Linux では走っているバイナリを unlink できる（実体は参照が切れるまで残る）。
 * 入れ替えに困らないので、この検証の対象にならない。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { prepareTestDb } from './helpers/prepare-db.mjs';
import { withId } from './helpers/cli-args.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const win = process.platform === 'win32';

const TEST_DATA = join(root, 'tmp', '_data', 'unit-exe-swap');
const WORK = join(root, 'tmp', 'exe-swap');

/** 走らせる実物。ビルド済みの Rust 版を写して使う */
const SOURCE = join(root, win ? 'aichat-rs.exe' : 'aichat-rs');
/** 走らせる側。ここを入れ替える */
const PROBE = join(WORK, win ? 'probe.exe' : 'probe');
/** 逃がす先 */
const PARKED = join(WORK, win ? 'probe-old.exe' : 'probe-old');

process.env.AICHAT_NO_EXIT = '1';
await prepareTestDb(TEST_DATA);

const { startServers, stopServers } = await import('../src/server/server.mjs');
const { TEST_ACCESS_TOKEN } = await import('../src/server/config.mjs');

let servers;
let base;
/** 走らせた待受け */
let child;
/** 子が終わったときの終了コード。生きている間は null */
let exited = null;
/** 子の出力。落ちた理由を assert のメッセージに出すために貯める */
let childOutput = '';

/** 終わるまで待つ（最大 ms） */
function waitForExit(ms) {
	return new Promise((resolve) => {
		if (exited !== null) return resolve(true);
		const timer = setTimeout(() => resolve(false), ms);
		child.once('exit', () => {
			clearTimeout(timer);
			resolve(true);
		});
	});
}

before(async () => {
	if (!win) return;
	assert.ok(existsSync(SOURCE), `先にビルドが要る: ${SOURCE.replace(root, '.')}`);

	servers = await startServers(0, ['127.0.0.1']);
	base = `http://127.0.0.1:${servers[0].address().port}`;

	rmSync(WORK, { recursive: true, force: true });
	mkdirSync(WORK, { recursive: true });
	copyFileSync(SOURCE, PROBE);

	/*
	 * 先に 1 度空読みして、カーソルを最後まで進める。
	 *
	 * これをしないと、既にある発言を新着として拾って即座に返ってしまう。
	 * 掴んだ状態を保てないと、この先の検証がすべて成り立たない。
	 *
	 * spawnSync は使えない。サーバーはこのプロセスの中で動いているので、
	 * 同期で待つとイベントループが止まり、子からの要求に応えられなくなる
	 * （待受けが応答を待ち、こちらが待受けを待つ形で噛み合う）。
	 */
	await new Promise((resolve, reject) => {
		const primer = spawn(
			PROBE,
			[...withId(['wait', '--wait-sec', '0'], 'exe-swap'), '--url', base, '--access-token', TEST_ACCESS_TOKEN],
			{ stdio: 'ignore' }
		);
		const timer = setTimeout(() => {
			primer.kill();
			reject(new Error('空読みが終わらなかった'));
		}, 10_000);
		primer.once('exit', () => {
			clearTimeout(timer);
			resolve();
		});
		primer.once('error', (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});

	/*
	 * 待受けとして走らせる。こちらから止めるので長くは待たせない。
	 *
	 * spawn イベントは CreateProcess が成功した時点で発火する。その時点で
	 * exe のイメージはメモリへマップされているので、以降は掴まれた状態になる。
	 */
	child = spawn(
		PROBE,
		[...withId(['wait', '--wait-sec', '20'], 'exe-swap'), '--url', base, '--access-token', TEST_ACCESS_TOKEN],
		{ stdio: ['ignore', 'pipe', 'pipe'] }
	);
	child.stdout.on('data', (b) => {
		childOutput += b.toString();
	});
	child.stderr.on('data', (b) => {
		childOutput += b.toString();
	});
	child.on('exit', (code) => {
		exited = code ?? -1;
	});
	await new Promise((resolve, reject) => {
		child.once('spawn', resolve);
		child.once('error', reject);
	});
});

after(async () => {
	if (!win) return;
	if (child && exited === null) {
		child.kill();
		await waitForExit(3000);
	}
	if (servers) await stopServers(servers);
	rmSync(WORK, { recursive: true, force: true });
});

describe('走っている exe の入れ替え', { skip: win ? false : 'Windows 専用' }, () => {
	test('走っている exe は消せない', () => {
		/*
		 * ここが成功してしまうと、ビルドが黙って待受けの足元を外すことになる。
		 * 「消せない」ことを確かめてから、改名で逃がす形に進む。
		 */
		assert.equal(exited, null, '待受けが先に終わっている（この先の検証が成り立たない）');

		let code = null;
		try {
			unlinkSync(PROBE);
		} catch (err) {
			code = err.code;
		}
		assert.ok(code === 'EBUSY' || code === 'EPERM', `消せてしまった（code=${code}）`);
		assert.ok(existsSync(PROBE), '消えている');
	});

	test('走っている exe は名前を変えられる', () => {
		// 同じボリューム内であること。tmp/ は root と同じドライブにある
		renameSync(PROBE, PARKED);
		assert.ok(existsSync(PARKED), '逃がせていない');
		assert.ok(!existsSync(PROBE), '元の名前が残っている');
	});

	test('名前を変えても、走っているプロセスは落ちない', async () => {
		/*
		 * ここが本題。改名した側は、開いたままの実体を使い続ける。
		 * 落ちるなら他プロジェクトの待受けを巻き添えにすることになる。
		 */
		const finished = await waitForExit(300);
		assert.equal(finished, false, `落ちた（exit=${exited}）: ${childOutput.trim()}`);
	});

	test('空いた名前に新しいものを置ける', () => {
		copyFileSync(SOURCE, PROBE);
		assert.ok(existsSync(PROBE), '置けていない');
		// 逃がした側もまだ居る。2 つが同時に存在する状態になる
		assert.ok(existsSync(PARKED), '逃がした側が消えている');
	});

	test('置き換えたあとも、走っているプロセスは落ちない', async () => {
		const finished = await waitForExit(300);
		assert.equal(finished, false, `落ちた（exit=${exited}）: ${childOutput.trim()}`);
	});

	test('待受けが終われば、逃がしたものを消せる', async () => {
		/*
		 * 退避したものは、その場では消せない。次のビルドで消せるだけ消す形になる。
		 * 「いつになったら消せるのか」を、ここで押さえておく。
		 */
		let code = null;
		try {
			unlinkSync(PARKED);
		} catch (err) {
			code = err.code;
		}
		assert.ok(code === 'EBUSY' || code === 'EPERM', `走っている間に消せてしまった（code=${code}）`);

		child.kill();
		const finished = await waitForExit(3000);
		assert.equal(finished, true, '止められなかった');

		unlinkSync(PARKED);
		assert.ok(!existsSync(PARKED), '消せていない');
	});
});
