import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const TEST_DATA = join(here, '..', 'tmp', '_data', 'unit-client-unreachable');
const CLIENT = join(here, '..', 'src', 'client', 'chat.mjs');

process.env.AICHAT_DATA = TEST_DATA;
rmSync(TEST_DATA, { recursive: true, force: true });

const { RETRY_INTERVAL_SEC, RETRY_TIMES, EXIT_UNREACHABLE } = await import('../src/client/options.mjs');
const { withId } = await import('./helpers/cli-args.mjs');
const { createMaintenanceHandler } = await import('../src/server/maintenance-handler.mjs');
const { startListening, closeListening } = await import('../src/server/listen.mjs');

/** 失敗する呼び出しを、終了コードと出力ごと受け取る */
async function failing(args) {
	try {
		await run(process.execPath, [CLIENT, ...args], { env: { ...process.env } });
		assert.fail(`エラーにならなかった: ${args.join(' ')}`);
	} catch (err) {
		return { code: err.code, stderr: err.stderr, stdout: err.stdout };
	}
}

describe('繋ぎ直す回数の決め', () => {
	/*
	 * 実際に粘らせると 1 回で 10 分かかるため、ここでは表の値だけを確かめる。
	 * 粘る動き自体は「粘らないコマンド」で見る（下の describe）。
	 */
	test('wait はいちばん長く粘る', () => {
		assert.equal(RETRY_TIMES.wait * RETRY_INTERVAL_SEC, 600, 'wait が 10 分になっていない');
	});

	test('ふつうのコマンドは 60 秒で諦める', () => {
		// 人が打つ。返事が来ないと判断できない
		assert.equal(RETRY_TIMES.default * RETRY_INTERVAL_SEC, 60);
	});

	test('止めに行くコマンドは粘らない', () => {
		// 止めに行くコマンドが繋がらない＝すでに止まっている
		assert.equal(RETRY_TIMES.restart, 0);
		assert.equal(RETRY_TIMES.stop, 0);
	});
});

describe('繋がらないとき', () => {
	test('粘らないコマンドは即座に終了コード 3 で終わる', async () => {
		// 誰も待ち受けていないポートを使う
		const { code, stderr } = await failing(withId(['stop', '--port', '1'], 'test-connector1'));

		assert.equal(code, EXIT_UNREACHABLE, '終了コードが 3 でない');
		assert.match(stderr, /諦めました/);
		assert.match(stderr, /繋がりません/);
	});

	test('終了コードで「使い方の誤り」と区別できる', async () => {
		// 2 は使い方の誤り、3 は向こうの都合。呼ぶ側がどちらか分かるようにしてある
		const wrongUsage = await failing(
			withId(['wait', '--wait-hour', '1', '--wait-min', '30', '--port', '1'], 'test-connector1')
		);

		assert.equal(wrongUsage.code, 2);
		assert.notEqual(wrongUsage.code, EXIT_UNREACHABLE);
	});
});

describe('メンテナンス中に叩いたとき', () => {
	let servers;
	let port;

	before(async () => {
		servers = await startListening(
			createMaintenanceHandler({ reason: 'DB を作り直しています', retryAfterSec: 180 }),
			0,
			['127.0.0.1']
		);
		port = servers[0].address().port;
	});

	after(async () => {
		await closeListening(servers);
	});

	test('503 は「繋がらない」と同じ扱いで、理由が出る', async () => {
		const { code, stderr } = await failing(withId(['stop', '--port', String(port)], 'test-connector1'));

		assert.equal(code, EXIT_UNREACHABLE);
		assert.match(stderr, /メンテナンス中です/);
		assert.match(stderr, /DB を作り直しています/);
	});

});

describe('求め方が悪いと言われたとき', () => {
	let servers;
	let port;

	/*
	 * わざと 400 を返すだけのサーバーを立てる。
	 *
	 * 以前はメンテナンス中のサーバーへ本文が空の say を投げていたが、
	 * 空の本文は CLI が手元で弾くため、サーバーまで届いていなかった。
	 * 「400 なら粘らない」ことを確かめたつもりで、何も確かめていなかった。
	 */
	before(async () => {
		servers = await startListening(
			(req, res) => {
				res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
				res.end(JSON.stringify({ error: 'わざと 400 を返しています' }));
			},
			0,
			['127.0.0.1']
		);
		port = servers[0].address().port;
	});

	after(async () => {
		await closeListening(servers);
	});

	test('400 は粘らずに終了コード 1 で終わる', async () => {
		/*
		 * 向こうの都合ではなく、こちらの求め方の問題。粘っても直らない。
		 * 3（繋がらない）と区別できることが要点。
		 */
		const { code, stderr } = await failing(withId(['say', '本文はある', '--port', String(port)], 'test-connector1'));

		assert.equal(code, 1);
		assert.notEqual(code, EXIT_UNREACHABLE, '繋がらないと同じ扱いになっている');
		assert.match(stderr, /わざと 400 を返しています/);
	});

	test('粘った跡が残らない', async () => {
		// 繋がらないときは「繋がりません」と出して待つ。400 ではそれが出ないこと
		const { stderr } = await failing(withId(['say', '本文はある', '--port', String(port)], 'test-connector1'));

		assert.doesNotMatch(stderr, /繋がりません/);
		assert.doesNotMatch(stderr, /諦めました/);
	});
});
