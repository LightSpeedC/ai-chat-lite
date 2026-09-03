/*
 * 返信（--reply-to）と、出力に出す番号を確かめる。
 *
 * 【なぜ番号を出すのか】
 * 出さないと、受け取った発言に返信しようにも指す先を書けない。
 * 列とオプションだけ足しても使えないので、番号の表示までが 1 組になる。
 *
 * 【なぜ # を付けるのか】
 * 付けないと「474 2026/09/04」と数が 2 つ並び、番号と日付の境目を
 * 読み手が判断することになる。
 *
 * 【なぜ指す先の存在を確かめないのか】
 * 片付けられた発言を指すことがある。存在を強いると、返信が付いた発言を
 * 片付けられなくなる。画面は指す先が無ければ引用を出さないだけにする。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { prepareTestDb } from './helpers/prepare-db.mjs';
import { wrapId } from './helpers/cli-args.mjs';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const TEST_DATA = join(here, '..', 'tmp', '_data', 'unit-reply');
const CLIENT = join(here, '..', 'src', 'client', 'chat.mjs');

process.env.AICHAT_NO_EXIT = '1';
await prepareTestDb(TEST_DATA);

const { startServers, stopServers } = await import('../src/server/server.mjs');
const { TEST_ACCESS_TOKEN } = await import('../src/server/config.mjs');

let servers;
let base;

before(async () => {
	servers = await startServers(0, ['127.0.0.1']);
	base = `http://127.0.0.1:${servers[0].address().port}`;
});

after(async () => {
	await stopServers(servers);
});

function cli(args) {
	return run(process.execPath, [CLIENT, ...args, '--url', base, '--access-token', TEST_ACCESS_TOKEN], {
		env: { ...process.env },
	});
}

async function failing(args) {
	try {
		await cli(args);
		assert.fail(`エラーにならなかった: ${args.join(' ')}`);
	} catch (err) {
		return { code: err.code, stderr: err.stderr ?? '' };
	}
}

/** say して、採番された msg_seq を返す */
async function say(id, body, extra = []) {
	const { stdout } = await cli(['say', wrapId(id), body, ...extra]);
	const m = /送信しました（(\d+)）/.exec(stdout);
	assert.ok(m, `msg_seq が読めない: ${stdout}`);
	return Number(m[1]);
}

describe('出力に番号が出る', () => {
	test('先頭に # つきの msg_seq が出る', async () => {
		const seq = await say('test-a', '親の発言');
		const { stdout } = await cli(['recent', '-n', '1']);

		assert.match(stdout, new RegExp(`#${seq} `), '番号が出ていない');
	});

	test('6 桁で右詰めになっている', async () => {
		// 3 桁までなら左に空白が入る。日付の列が揃う
		const { stdout } = await cli(['recent', '-n', '1']);
		const line = stdout.split(/\r?\n/).find((l) => l.includes('#'));

		assert.match(line, /^ +#\d+ \d{4}\/\d{2}\/\d{2} /, `形が違う: [${line}]`);
	});

	test('仕組みからの発言にも番号が出る', async () => {
		/*
		 * 種別で出し分けると、読み手が「番号が無い行は何か」を考えることになる。
		 * join は参加の知らせを積む
		 */
		await cli(['join', wrapId('test-sys')]);
		const { stdout } = await cli(['recent', '-n', '3']);
		const line = stdout.split(/\r?\n/).find((l) => l.includes(' -- '));

		assert.ok(line, '仕組みからの発言が無い');
		assert.match(line, /^ +#\d+ \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\.\d{3} -- /, `形が違う: [${line}]`);
	});
});

describe('返信', () => {
	test('--reply-to で親の番号が残る', async () => {
		const parent = await say('test-a', '親の発言');
		await say('test-b', '返答です', ['--reply-to', String(parent)]);

		const { stdout } = await cli(['recent', '-n', '1']);
		assert.match(stdout, new RegExp(`↳#${parent} `), '返信先が出ていない');
	});

	test('先頭の # を付けても通る', async () => {
		// 出力には #474 と出るので、画面から写した人がそのまま貼れる
		const parent = await say('test-a', 'もう 1 つの親');
		await say('test-b', '写して貼った', ['--reply-to', `#${parent}`]);

		const { stdout } = await cli(['recent', '-n', '1']);
		assert.match(stdout, new RegExp(`↳#${parent} `));
	});

	test('--to と併用できる', async () => {
		// 誰に・どれへ、の両方を持てる
		const parent = await say('test-a', '名指しの親');
		await say('test-b', '名指しの返答', ['--to', wrapId('test-a'), '--reply-to', String(parent)]);

		const { stdout } = await cli(['recent', '-n', '1']);
		assert.match(stdout, new RegExp(`test-b @test-a ↳#${parent} > 名指しの返答`));
	});

	test('渡さなければ ↳ が出ない', async () => {
		await say('test-a', 'ただの発言');
		const { stdout } = await cli(['recent', '-n', '1']);

		assert.doesNotMatch(stdout, /↳/);
	});

	test('片付けられた発言を指しても通る', async () => {
		/*
		 * 存在を強いると、返信が付いた発言を片付けられなくなる。
		 * まだ採番されていない番号でも同じ扱いにする。
		 */
		const notYet = 999999;
		await say('test-b', '未来の番号を指す', ['--reply-to', String(notYet)]);

		const { stdout } = await cli(['recent', '-n', '1']);
		assert.match(stdout, new RegExp(`↳#${notYet} `));
	});
});

describe('誤りは断る', () => {
	test('数でなければ終了コード 2 で止まる', async () => {
		const { code, stderr } = await failing(['say', wrapId('test-a'), '本文', '--reply-to', 'あ']);

		assert.equal(code, 2);
		assert.match(stderr, /1 以上の数を渡してください/);
		assert.match(stderr, /#474 の形で出ています/);
	});

	test('0 以下は断る', async () => {
		for (const bad of ['0', '-1']) {
			const { code } = await failing(['say', wrapId('test-a'), '本文', '--reply-to', bad]);
			assert.equal(code, 2, `${bad} が断られていない`);
		}
	});

	test('サーバーも整数以外を断る', async () => {
		// CLI を通さず直に叩かれても守る
		const res = await fetch(`${base}/api/say`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'X-AiChat-Access-Token': TEST_ACCESS_TOKEN },
			body: JSON.stringify({
				from_connector_id: 'test-a',
				msg_body: '直に叩く',
				reply_to_msg_seq: 1.5,
			}),
		});

		assert.equal(res.status, 400);
		const body = await res.json();
		assert.match(body.error, /reply_to_msg_seq/);
	});
});

describe('日時の書式', () => {
	test('yyyy/mm/dd で出る', async () => {
		await say('test-a', '書式の確認');
		const { stdout } = await cli(['recent', '-n', '1']);

		assert.match(stdout, /\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\.\d{3}/);
		assert.doesNotMatch(stdout, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/, '旧形式が残っている');
	});

	test('who の最終時刻も揃う', async () => {
		const { stdout } = await cli(['who']);

		assert.match(stdout, /最終 \d{4}\/\d{2}\/\d{2} /);
	});
});
