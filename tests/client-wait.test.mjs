import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { prepareTestDb } from './helpers/prepare-db.mjs';
import { withId } from './helpers/cli-args.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const TEST_DATA = join(here, '..', 'tmp', '_data', 'unit-client-wait');
const CLIENT = join(here, '..', 'src', 'client', 'chat.mjs');

// 版を当ててから store を読み込む（store.mjs は形を作らない）
process.env.AICHAT_NO_EXIT = '1';
await prepareTestDb(TEST_DATA);

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
function chat(args, connectorId = 'test-connector1') {
	// テスト用として立っているので、アクセストークンを渡さないと 403 になる。
	// 接続先と名乗る ID は引数で渡す（環境変数では渡せない）
	return run(
		process.execPath,
		[CLIENT, ...withId(args, connectorId), '--url', base, '--access-token', TEST_ACCESS_TOKEN],
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

		assert.match(stdout, /pid \d+ で待受け中（最大 3 秒/);
		assert.match(stdout, /新着なし（3 秒待機/);
		assert.ok(elapsed >= 2500, `待たずに返っている（${elapsed}ms）`);
	});

	test('新着があれば残りを待たずに返る', async () => {
		const startedAt = Date.now();
		// 25 秒待つ設定。すぐ届けば数秒で戻るはず
		const waiting = chat(['wait', '--wait-sec', '25']);
		await chat(['say', 'いま届く'], 'test-connector2');

		const { stdout } = await waiting;
		const elapsed = Date.now() - startedAt;

		assert.match(stdout, /新着 1 件/);
		assert.match(stdout, /いま届く/);
		assert.ok(elapsed < 20000, `残りを待ってしまっている（${elapsed}ms）`);
	});

	test('何も指定しなければ 12 時間になる', async () => {
		/*
		 * 12 時間を実際に待たせるわけにいかないので、先に発言を置いて
		 * 1 回目で返るようにする。開始の行に長さが出る
		 */
		await chat(['say', '既定の確認'], 'test-connector2');
		const { stdout } = await chat(['wait']);

		assert.match(stdout, /pid \d+ で待受け中（最大 12 時間/);
		assert.match(stdout, /新着 1 件/);
	});

	test('0 を渡すと上限なしになる', async () => {
		// 上限なしは止まらないので、先に発言を置いて返らせる
		await chat(['say', '上限なしの確認'], 'test-connector2');
		const { stdout } = await chat(['wait', '--wait-sec', '0']);

		assert.match(stdout, /pid \d+ で待受け中（最大 上限なし/);
		assert.match(stdout, /新着 1 件/);
	});

	test('分と時でも同じ長さを指定できる', async () => {
		await chat(['say', '単位の確認'], 'test-connector2');
		const byMin = await chat(['wait', '--wait-min', '60']);
		assert.match(byMin.stdout, /pid \d+ で待受け中（最大 1 時間/);

		await chat(['say', '単位の確認 2'], 'test-connector2');
		const byHour = await chat(['wait', '--wait-hour', '1']);
		assert.match(byHour.stdout, /pid \d+ で待受け中（最大 1 時間/);
	});

	test('短い形 -w は --wait-hour と同じ', async () => {
		await chat(['say', '短い形の確認'], 'test-connector2');
		const { stdout } = await chat(['wait', '-w', '2']);

		assert.match(stdout, /pid \d+ で待受け中（最大 2 時間/);
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
	test('待受け中の行に pid が出る', async () => {
		/*
		 * この 1 行だけを見た相手に「終わった」と読ませないため、進行形にしてある。
		 * pid は aichat waiters が名指しする値と同じで、走っているかを確かめる手がかりになる。
		 */
		const { stdout } = await chat(['wait', '--wait-sec', '1']);
		const pid = /^pid (\d+) で待受け中（/.exec(stdout);

		assert.ok(pid, `pid が出ていない:\n${stdout}`);
		assert.ok(Number(pid[1]) > 0, `pid が数でない: ${pid[1]}`);
	});

	test('出るのは開始と終了の 2 行だけ', async () => {
		/*
		 * 240 秒ごとに「新着なし」を出していたため、12 時間で 180 行になっていた。
		 * 何回に分けて待ったかは呼ぶ側に関係がないので出さない
		 */
		const { stdout } = await chat(['wait', '--wait-sec', '1']);
		const lines = stdout.trim().split('\n');

		assert.equal(lines.length, 2, `2 行ではない:\n${stdout}`);
		assert.match(lines[0], /^pid \d+ で待受け中（/);
		assert.match(lines[1], /^新着なし（/);
		assert.doesNotMatch(stdout, /回目/);
	});

	test('長く待つ設定を自分で書いたときはバックグラウンド実行を促す', async () => {
		/*
		 * 601 秒を実際に待たせるわけにいかないので、先に発言を置いて
		 * 1 回目で返るようにする。警告は待ち始める前に出る
		 */
		await chat(['say', '警告の確認'], 'test-connector2');
		const { stdout, stderr } = await chat(['wait', '--wait-min', '11']);

		assert.match(stderr, /11 分（660 秒）待つ設定です。/);
		assert.match(stderr, /run_in_background/);
		// 警告を出すだけで、待つこと自体は妨げない
		assert.match(stdout, /新着 1 件/);
	});

	test('秒で指定したときは括弧を繰り返さない', async () => {
		/*
		 * 括弧は「11 分」を秒に直して見せるためのもの。--wait-sec では
		 * label 自体が秒なので、同じ値が 2 度出ていた
		 */
		await chat(['say', '括弧の確認'], 'test-connector2');
		const { stderr } = await chat(['wait', '--wait-sec', '610']);

		assert.match(stderr, /610 秒待つ設定です。/);
		assert.doesNotMatch(stderr, /（610 秒）/);
	});

	test('短い設定では背面実行の案内を出さない', async () => {
		const { stderr } = await chat(['wait', '--wait-sec', '1']);

		// 出るのはどちらの環境かの印だけ。案内は出ない
		assert.match(stderr, /^テスト（/);
		assert.doesNotMatch(stderr, /run_in_background/);
	});

	test('既定の 12 時間では背面実行の案内を出さない', async () => {
		// 既定が 600 秒を超えているため、毎回出すと警告の意味がなくなる
		await chat(['say', '既定では黙る'], 'test-connector2');
		const { stderr } = await chat(['wait']);

		// 出るのはどちらの環境かの印だけ。案内は出ない
		assert.match(stderr, /^テスト（/);
		assert.doesNotMatch(stderr, /run_in_background/);
	});

	test('waiters ではどちらの環境かを出さない', async () => {
		/*
		 * サーバーに繋がないコマンドなので、聞く相手がいない。
		 * 出すかどうかは options.mjs の offline で決まり、CLI 2 本が同じ値を読む。
		 */
		const { stderr } = await chat(['waiters']);

		assert.doesNotMatch(stderr, /テスト（|本番（/);
	});
});

describe('複数のルームを 1 本で待つ', () => {
	/*
	 * 【なぜ CLI を通して見るのか】
	 * サーバー側は multi-room.test.mjs が API を直に叩いて確かめている。だが
	 * 「複数のときは msg_seq を添えない」という応答の形を CLI が読んでおり、
	 * その継ぎ目に穴があった（現在位置 0 と出た）。両側を別々に確かめても
	 * 継ぎ目は見えない。CLI を動かして初めて分かる。
	 */
	test('1 ルームなら現在位置は数だけ', async () => {
		const { stdout } = await chat(['wait', '--wait-sec', '1']);

		assert.match(stdout, /新着なし（1 秒待機、現在位置 \d+）/);
	});

	test('複数ルームなら現在位置をルームごとに出す', async () => {
		// sandbox-multi は初めて見るルームなので、まず案内を出して終わる 1 回を消費する
		// （i260909-01）。位置の形を見たいのはその次の呼び出し
		await chat(['wait', '-r', 'public,sandbox-multi', '--wait-sec', '1']);

		// 1 つの数で出すと、どのルームの位置か分からない
		const { stdout } = await chat(['wait', '-r', 'public,sandbox-multi', '--wait-sec', '1']);

		assert.match(stdout, /現在位置 public \d+ \/ sandbox-multi \d+/, `形が違う: [${stdout}]`);
	});

	test('どちらのルームの新着でも返る', async () => {
		await chat(['say', '別のルームへ', '-r', 'sandbox-multi'], 'test-connector2');
		const { stdout } = await chat(['wait', '-r', 'public,sandbox-multi', '--wait-sec', '5']);

		assert.match(stdout, /新着 1 件/);
		assert.match(stdout, /\[sandbox-multi\]/, 'どのルームの発言か出ていない');
	});

	test('見出しの行にルームが出る', async () => {
		await chat(['say', 'ルームの印'], 'test-connector2');
		const { stdout } = await chat(['wait', '--wait-sec', '5']);

		assert.match(stdout, /^──────── \[public\] #\d+ /m, `形が違う: [${stdout}]`);
	});

	/*
	 * since を渡したときに断られることは、multi-room.test.mjs が API を直に叩いて
	 * 確かめている。CLI には since を渡す口が無い（どこまで読んだかはサーバーが
	 * 覚えている）ので、ここでは確かめられない。
	 */

	/*
	 * 【なぜ必要か】
	 * 「初めての接続」判定（i260909-01）は、指定したルームのうち 1 つでも
	 * 初めてなら true になる（server.mjs の some()）。案内を出したあとの
	 * wait=0 の poll は、指定したルーム全部（初めてでない public も含めて）に
	 * 対して行われる。public に既存の未読があっても、その戻り値を画面に出さず
	 * カーソルだけ最新まで進めていたため、初めてのルームを 1 つ混ぜて wait
	 * しただけで、既存ルームの未読が「読んだこと」にされ二度と出なくなっていた
	 * （実際に他プロジェクトから報告があった事故）
	 */
	test('初めてのルームと混ぜても、既存ルームの未読は消えない', async () => {
		const me = 'test-mixed-first';
		await chat(['join'], me);
		await chat(['wait', '--wait-sec', '1'], me); // public のカーソルを立てる

		// public に、me からはまだ見えていない新着を作る
		await chat(['say', 'これは読めるはず'], 'test-connector2');

		// sandbox-firstmix は初めて。public は既存カーソルあり。案内を出して終わる 1 回
		await chat(['wait', '-r', 'public,sandbox-firstmix', '--wait-sec', '1'], me);

		// 改めて待つと、public の未読が届くはず
		const { stdout } = await chat(['wait', '-r', 'public,sandbox-firstmix', '--wait-sec', '3'], me);
		assert.match(stdout, /これは読めるはず/, '既存ルームの未読が消えている');
	});
});
