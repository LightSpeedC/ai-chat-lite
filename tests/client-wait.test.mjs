import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const TEST_DATA = join(here, '..', 'tmp', '_data', 'unit-client-wait');
const CLIENT = join(here, '..', 'src', 'client', 'chat.mjs');

process.env.AICHAT_DATA = TEST_DATA;
process.env.AICHAT_NO_EXIT = '1';
rmSync(TEST_DATA, { recursive: true, force: true });

const { startServers, stopServers } = await import('../src/server/server.mjs');
const { TEST_ACCESS_TOKEN } = await import('../src/server/config.mjs');

let servers;
let base;

/**
 * CLI を子プロセスとして動かす。
 *
 * chat.mjs はトップレベルで実行される作りなので、import では試せない。
 * 実際に人や AI が呼ぶのと同じ形で確かめる。
 */
function chat(args, connectorId = 'user1') {
	// テスト用として立っているので、アクセストークンを渡さないと 403 になる。
	// 接続先と名乗る ID は引数で渡す（環境変数では渡せない）
	return run(
		process.execPath,
		[CLIENT, ...args, '--url', base, '--access-token', TEST_ACCESS_TOKEN, '--connector-id', connectorId],
		{ env: { ...process.env } }
	);
}

before(async () => {
	servers = await startServers(0, ['127.0.0.1']);
	base = `http://127.0.0.1:${servers[0].address().port}`;
	await chat(['join']);
	// 参加の記録を読み終えた状態にする。以降は新着なしから始まる
	await chat(['wait', '--wait-sec', '1']);
});

after(async () => {
	await stopServers(servers);
});

describe('wait の待つ長さ', () => {
	test('指定した長さだけ待って、新着が無ければ終わる', async () => {
		const startedAt = Date.now();
		const { stdout } = await chat(['wait', '--wait-sec', '3']);
		const elapsed = Date.now() - startedAt;

		assert.match(stdout, /待受け開始（最大 3 秒/);
		assert.match(stdout, /新着なし（3 秒待機/);
		assert.ok(elapsed >= 2500, `待たずに返っている（${elapsed}ms）`);
	});

	test('新着があれば残りを待たずに返る', async () => {
		const startedAt = Date.now();
		// 25 秒待つ設定。すぐ届けば数秒で戻るはず
		const waiting = chat(['wait', '--wait-sec', '25']);
		await chat(['say', 'いま届く'], 'user2');

		const { stdout } = await waiting;
		const elapsed = Date.now() - startedAt;

		assert.match(stdout, /新着 1 件/);
		assert.match(stdout, /いま届く/);
		assert.ok(elapsed < 20000, `残りを待ってしまっている（${elapsed}ms）`);
	});

	test('何も指定しなければ 8 時間になる', async () => {
		/*
		 * 8 時間を実際に待たせるわけにいかないので、先に発言を置いて
		 * 1 回目で返るようにする。開始の行に長さが出る
		 */
		await chat(['say', '既定の確認'], 'user2');
		const { stdout } = await chat(['wait']);

		assert.match(stdout, /待受け開始（最大 8 時間/);
		assert.match(stdout, /新着 1 件/);
	});

	test('0 を渡すと上限なしになる', async () => {
		// 上限なしは止まらないので、先に発言を置いて返らせる
		await chat(['say', '上限なしの確認'], 'user2');
		const { stdout } = await chat(['wait', '--wait-sec', '0']);

		assert.match(stdout, /待受け開始（最大 上限なし/);
		assert.match(stdout, /新着 1 件/);
	});

	test('分と時でも同じ長さを指定できる', async () => {
		await chat(['say', '単位の確認'], 'user2');
		const byMin = await chat(['wait', '--wait-min', '60']);
		assert.match(byMin.stdout, /待受け開始（最大 1 時間/);

		await chat(['say', '単位の確認 2'], 'user2');
		const byHour = await chat(['wait', '--wait-hour', '1']);
		assert.match(byHour.stdout, /待受け開始（最大 1 時間/);
	});

	test('短い形 -w は --wait-hour と同じ', async () => {
		await chat(['say', '短い形の確認'], 'user2');
		const { stdout } = await chat(['wait', '-w', '2']);

		assert.match(stdout, /待受け開始（最大 2 時間/);
	});
});

describe('wait の指定を誤ったとき', () => {
	/** 失敗する呼び出しを、終了コードと標準エラーごと受け取る */
	async function failing(args) {
		try {
			await chat(args);
			assert.fail('エラーにならなかった');
		} catch (err) {
			return { code: err.code, stderr: err.stderr };
		}
	}

	test('単位を 2 つ指定するとエラーになる', async () => {
		const { code, stderr } = await failing(['wait', '--wait-hour', '1', '--wait-min', '30']);

		assert.equal(code, 2);
		assert.match(stderr, /1 つだけ指定してください/);
		assert.match(stderr, /--wait-hour/);
		assert.match(stderr, /--wait-min/);
	});

	test('数でない値を渡すとエラーになる', async () => {
		const { code, stderr } = await failing(['wait', '--wait-min', 'たくさん']);

		assert.equal(code, 2);
		assert.match(stderr, /0 以上の数だけを渡してください/);
	});

	test('廃止した --retry-count と --timeout はエラーで知らせる', async () => {
		// 他プロジェクトの手順に古い形が残っている。黙って無視すると気づけない
		for (const name of ['--retry-count', '--timeout']) {
			const { code, stderr } = await failing(['wait', name, '2']);

			assert.equal(code, 2, `${name} が終了コード 2 にならない`);
			assert.match(stderr, new RegExp(`${name} は廃止されました`));
			assert.match(stderr, /--wait-hour/);
		}
	});
});

describe('wait のログ', () => {
	test('出るのは開始と終了の 2 行だけ', async () => {
		/*
		 * 240 秒ごとに「新着なし」を出していたため、8 時間で 120 行になっていた。
		 * 何回に分けて待ったかは呼ぶ側に関係がないので出さない
		 */
		const { stdout } = await chat(['wait', '--wait-sec', '1']);
		const lines = stdout.trim().split('\n');

		assert.equal(lines.length, 2, `2 行ではない:\n${stdout}`);
		assert.match(lines[0], /^待受け開始（/);
		assert.match(lines[1], /^新着なし（/);
		assert.doesNotMatch(stdout, /回目/);
	});

	test('長く待つ設定を自分で書いたときはバックグラウンド実行を促す', async () => {
		/*
		 * 601 秒を実際に待たせるわけにいかないので、先に発言を置いて
		 * 1 回目で返るようにする。警告は待ち始める前に出る
		 */
		await chat(['say', '警告の確認'], 'user2');
		const { stdout, stderr } = await chat(['wait', '--wait-min', '11']);

		assert.match(stderr, /11 分/);
		assert.match(stderr, /run_in_background/);
		// 警告を出すだけで、待つこと自体は妨げない
		assert.match(stdout, /新着 1 件/);
	});

	test('短い設定では警告を出さない', async () => {
		const { stderr } = await chat(['wait', '--wait-sec', '1']);
		assert.equal(stderr, '');
	});

	test('既定の 8 時間では警告を出さない', async () => {
		// 既定が 600 秒を超えているため、毎回出すと警告の意味がなくなる
		await chat(['say', '既定では黙る'], 'user2');
		const { stderr } = await chat(['wait']);

		assert.equal(stderr, '');
	});
});
