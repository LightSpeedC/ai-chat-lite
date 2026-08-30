import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const TEST_DB = join(here, '..', 'tmp', 'test-client-wait.db');
const CLIENT = join(here, '..', 'src', 'client', 'chat.mjs');

process.env.AICHAT_DB = TEST_DB;
process.env.AICHAT_NO_EXIT = '1';
for (const suffix of ['', '-wal', '-shm']) rmSync(TEST_DB + suffix, { force: true });

const { startServers, stopServers } = await import('../src/server/server.mjs');

let servers;
let base;

/**
 * CLI を子プロセスとして動かす。
 *
 * chat.mjs はトップレベルで実行される作りなので、import では試せない。
 * 実際に人や AI が呼ぶのと同じ形で確かめる。
 */
function chat(args, extraEnv = {}) {
	return run(process.execPath, [CLIENT, ...args], {
		env: {
			...process.env,
			AICHAT_URL: base,
			AICHAT_ID: 'user1',
			...extraEnv,
		},
	});
}

before(async () => {
	servers = await startServers(0, ['127.0.0.1']);
	base = `http://127.0.0.1:${servers[0].address().port}`;
	await chat(['join']);
	// 参加の記録を読み終えた状態にする。以降は新着なしから始まる
	await chat(['wait', '--timeout', '1', '--retry-count', '1']);
});

after(async () => {
	await stopServers(servers);
});

describe('wait の自動リトライ', () => {
	test('新着が無ければ指定した回数だけ待ち直す', async () => {
		const { stdout } = await chat(['wait', '--timeout', '1', '--retry-count', '3']);

		assert.match(stdout, /1\/3 回目/);
		assert.match(stdout, /2\/3 回目/);
		assert.match(stdout, /3 回・合計 3 秒待機/);
		// 最後の回は「待ち直します」を出さない。もう待たないため
		assert.doesNotMatch(stdout, /3\/3 回目/);
	});

	test('指定しなければ 2 回待つ', async () => {
		// 240 秒 × 2 = 480 秒。ツール実行が切られる 600 秒の内側に収める既定値
		const { stdout } = await chat(['wait', '--timeout', '1']);

		assert.match(stdout, /1\/2 回目/);
		assert.match(stdout, /2 回・合計 2 秒待機/);
	});

	test('新着があれば残りの回数を待たずに返る', async () => {
		const startedAt = Date.now();
		// 5 秒 × 5 回 = 25 秒の設定。すぐ届けば数秒で戻るはず
		const waiting = chat(['wait', '--timeout', '5', '--retry-count', '5']);
		await chat(['say', 'いま届く'], { AICHAT_ID: 'user2' });

		const { stdout } = await waiting;
		const elapsed = Date.now() - startedAt;

		assert.match(stdout, /新着 1 件/);
		assert.match(stdout, /いま届く/);
		assert.ok(elapsed < 20000, `残りの回数を待ってしまっている（${elapsed}ms）`);
	});

	test('回数に 0 や負の数を渡しても最低 1 回は待つ', async () => {
		// 0 を「待たない」と解釈すると、何も返さず即終了して使い道がなくなる
		for (const value of ['0', '-3']) {
			const { stdout } = await chat(['wait', '--timeout', '1', '--retry-count', value]);
			assert.match(stdout, /1 回・合計 1 秒待機/, `--retry-count ${value} で 1 回にならない`);
		}
	});

	test('回数に数でない値を渡すと既定に戻る', async () => {
		const { stdout } = await chat(['wait', '--timeout', '1', '--retry-count', 'たくさん']);
		assert.match(stdout, /2 回・合計 2 秒待機/);
	});

	test('合計が 600 秒を超えるとバックグラウンド実行を促す', async () => {
		/*
		 * バックグラウンド実行かどうかは、走っている側からは判別できない。
		 * 環境変数も TTY も通常の実行と同じ値になることを実測で確かめてある。
		 * そのため止めることはせず、警告を出したうえで続行する。
		 *
		 * 601 秒を実際に待たせるわけにいかないので、先に発言を置いて
		 * 1 回目で返るようにする。警告は待ち始める前に出る
		 */
		await chat(['say', '警告の確認'], { AICHAT_ID: 'user2' });
		const { stdout, stderr } = await chat(['wait', '--timeout', '1', '--retry-count', '601']);

		assert.match(stderr, /合計 601 秒/);
		assert.match(stderr, /run_in_background/);
		// 警告を出すだけで、待つこと自体は妨げない
		assert.match(stdout, /新着 1 件/);
	});

	test('合計が 600 秒に収まるうちは警告を出さない', async () => {
		const { stderr } = await chat(['wait', '--timeout', '1', '--retry-count', '2']);
		assert.equal(stderr, '');
	});
});
