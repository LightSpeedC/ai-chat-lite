/*
 * archive が終わるかどうかを確かめる。
 *
 * 【なぜ要るか】
 * 本番で `aichat archive` のシェルが 2 本、10 時間以上残っているのを見つけた
 * （課題 i260913-02）。片付け自体は成功しているのに終わっていない。
 *
 *   00:38:10 pid 29820  archives に記録なし … 確認待ちのまま止まったと見られる
 *   00:40:24 pid 22532  archives に seq 7   … 片付けを終えたのに終わっていない
 *
 * archive は「先に件数を出し、対象名の入力を求める」作りなので、背面で起こすと
 * 入力が来ない。そこで止まるのは筋が通る。しかし 2 本目は処理を終えている。
 *
 * どちらの経路で終わらないのかを、ここで切り分ける。
 *
 * 【本番を触らない】
 * サーバーはこのプロセスの中に立てる。ポートは自動割当。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { prepareTestDb } from './helpers/prepare-db.mjs';
import { withId } from './helpers/cli-args.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const win = process.platform === 'win32';

const TEST_DATA = join(root, 'tmp', '_data', 'unit-archive-exit');
const EXE = join(root, 'target', win ? 'aichat-rs.exe' : 'aichat-rs');
const NODE_CLI = join(root, 'src', 'client', 'chat.mjs');

/**
 * bun の在り処。
 *
 * 本番で残っていたのは bun 版だった（当時の aichat は sh から bun を起こしていた）。
 * ここを飛ばすと、再現しようとしている当の実装を試さないことになる。
 *
 * サーバーを立てる前に 1 度だけ呼ぶので、ここは同期でよい。
 */
const bunPath = (() => {
	const res = spawnSync(win ? 'where' : 'which', ['bun'], { encoding: 'utf8' });
	if (res.status !== 0) return null;
	return res.stdout.trim().split(/\r?\n/)[0] || null;
})();

process.env.AICHAT_NO_EXIT = '1';
await prepareTestDb(TEST_DATA);

const { startServers, stopServers } = await import('../src/server/server.mjs');
const { TEST_ACCESS_TOKEN } = await import('../src/server/config.mjs');

let servers;
let base;

/** ビルドしていなければ試せない */
const built = existsSync(EXE);

/**
 * CLI を起こし、終わるまで待つ。終わらなければ止めて、その旨を返す。
 *
 * spawnSync は使えない。サーバーが同じプロセスに居るため、同期で待つと
 * イベントループが止まって噛み合う（共通ルール「同期 API は〜」）。
 *
 * @param {string[]} args 引数
 * @param {string | null} input 標準入力に流すもの。null なら閉じる（背面と同じ）
 * @param {number} limitMs これを超えたら止める
 */
function runCli(runner, args, input, limitMs = 10_000) {
	return new Promise((resolve) => {
		const child = spawn(runner.file, [...runner.prefix, ...args], {
			stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
		});

		let out = '';
		child.stdout.on('data', (b) => {
			out += b.toString();
		});
		child.stderr.on('data', (b) => {
			out += b.toString();
		});

		if (input !== null) {
			child.stdin.write(input);
			child.stdin.end();
		}

		const startedAt = Date.now();
		const timer = setTimeout(() => {
			child.kill();
			resolve({ finished: false, code: null, out, ms: Date.now() - startedAt });
		}, limitMs);

		child.once('exit', (code) => {
			clearTimeout(timer);
			resolve({ finished: true, code, out, ms: Date.now() - startedAt });
		});
	});
}

/** 片付ける相手の発言を 1 件作る */
async function makeMessage(runner, text) {
	const res = await runCli(
		runner,
		[...withId(['say', text], 'probe'), '--url', base, '--access-token', TEST_ACCESS_TOKEN, '-r', 'public'],
		null
	);
	assert.equal(res.finished, true, `say が終わらなかった: ${res.out}`);
	const m = res.out.match(/（(\d+)）/);
	assert.ok(m, `送った番号が読み取れない: ${res.out}`);
	return Number(m[1]);
}

/**
 * 試す実装。
 *
 * 本番で残っていたのは bun 版なので、Rust 版だけを見ても再現しない。
 * 3 本とも同じ手順にかけて、どこで終わらないのかを切り分ける。
 */
const RUNNERS = [
	{ name: 'Rust 版', file: EXE, prefix: [], missing: built ? null : 'aichat-rs.exe が無い' },
	{ name: 'node 版', file: process.execPath, prefix: [NODE_CLI], missing: null },
	{ name: 'bun 版', file: bunPath ?? 'bun', prefix: ['run', NODE_CLI], missing: bunPath ? null : 'bun が無い' },
];

before(async () => {
	servers = await startServers(0, ['127.0.0.1']);
	base = `http://127.0.0.1:${servers[0].address().port}`;
});

after(async () => {
	if (servers) await stopServers(servers);
});

for (const runner of RUNNERS) {
	describe(`archive は必ず終わる（${runner.name}）`, () => {
		test('標準入力が閉じていても止まらない', async (t) => {
			if (runner.missing) return t.skip(runner.missing);

			/*
			 * 背面（run_in_background）で起こすと、この形になる。
			 * 入力を待ち続けるなら、ここで終わらない。
			 */
			const seq = await makeMessage(runner, '入力なしの調査用');
			const res = await runCli(
				runner,
				[
					...withId(['archive', 'message', String(seq)], 'probe'),
					'--url',
					base,
					'--access-token',
					TEST_ACCESS_TOKEN,
					'--description',
					'調査',
				],
				null
			);

			assert.equal(res.finished, true, `${res.ms} ms 待っても終わらなかった: ${res.out.trim()}`);
			assert.equal(res.code, 1, `終了コードが 1 でない: ${res.out.trim()}`);
		});

		test('標準入力が閉じていたら、渡し方を案内して中止する', async (t) => {
			if (runner.missing) return t.skip(runner.missing);

			/*
			 * 「中止しました。」だけでは、打ち間違えたのか入力が来なかったのか分からない。
			 * 実際に本番で 2 度試して 2 度とも止まり、原因が分からないままになった。
			 * 詰まったその場で渡し方が読めることを、ここで保証する。
			 */
			const seq = await makeMessage(runner, '案内の調査用');
			const res = await runCli(
				runner,
				[
					...withId(['archive', 'message', String(seq)], 'probe'),
					'--url',
					base,
					'--access-token',
					TEST_ACCESS_TOKEN,
					'--description',
					'調査',
				],
				null
			);

			assert.match(res.out, /標準入力が閉じている/, `理由が出ていない: ${res.out.trim()}`);
			assert.match(res.out, /--yes/, `--yes の案内が出ていない: ${res.out.trim()}`);
			assert.match(res.out, new RegExp(`printf '${seq}`), `渡し方が出ていない: ${res.out.trim()}`);
		});

		test('--yes を渡せば、標準入力が閉じていても片付けられる', async (t) => {
			if (runner.missing) return t.skip(runner.missing);

			/*
			 * 背面から片付ける唯一の手段。これが無いと、AI は archive を使えない。
			 * 確認を省くので、打ち間違いは止まらない。渡した側の責任になる。
			 */
			const seq = await makeMessage(runner, 'yes の調査用');
			const res = await runCli(
				runner,
				[
					...withId(['archive', 'message', String(seq)], 'probe'),
					'--yes',
					'--url',
					base,
					'--access-token',
					TEST_ACCESS_TOKEN,
					'--description',
					'調査',
				],
				null
			);

			assert.equal(res.finished, true, `${res.ms} ms 待っても終わらなかった: ${res.out.trim()}`);
			assert.equal(res.code, 0, `片付けられていない: ${res.out.trim()}`);
			assert.match(res.out, /片付けました（archived_seq \d+）/, `片付けた知らせが出ていない: ${res.out.trim()}`);
			assert.match(res.out, /戻すには: restore /, `戻し方が出ていない: ${res.out.trim()}`);
		});

		test('確認に答えたら、片付けたあとに終わる', async (t) => {
			if (runner.missing) return t.skip(runner.missing);

			/*
			 * 本番で残っていた 2 本目は、片付けを終えた 31 秒後の記録を残している。
			 * 処理が済んだあとに終わらないなら、ここで止まる。
			 */
			const seq = await makeMessage(runner, '入力ありの調査用');
			const res = await runCli(
				runner,
				[
					...withId(['archive', 'message', String(seq)], 'probe'),
					'--url',
					base,
					'--access-token',
					TEST_ACCESS_TOKEN,
					'--description',
					'調査',
				],
				`${seq}\n`
			);

			assert.equal(res.finished, true, `${res.ms} ms 待っても終わらなかった: ${res.out.trim()}`);
		});
	});
}
