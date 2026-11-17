/*
 * 返信 (--reply-to)と、出力に出す番号を確かめる。
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

/** say して、採番された msg_id (m{yymmdd}-nn) を返す */
async function say(id, body, extra = []) {
	const { stdout } = await cli(['say', wrapId(id), body, ...extra]);
	const m = /送信しました \((m\d{6}-[0-9a-km-z]{2,})\)/.exec(stdout);
	assert.ok(m, `msg_id が読めない: ${stdout}`);
	return m[1];
}

/** 今までの番号 (msg_seq) が要る試験のために、msg_id から msg_seq を引く */
async function seqOf(msgId) {
	const res = await fetch(`${base}/api/history?room_id=public&limit=200`, { headers: { 'X-AiChat-Access-Token': TEST_ACCESS_TOKEN } });
	const { messages } = await res.json();
	return messages.find((m) => m.msg_id === msgId).msg_seq;
}

describe('出力に番号が出る', () => {
	test('見出しに msg_id が出て、# はどこにも出ない', async () => {
		const id = await say('test-a', '親の発言');
		const { stdout } = await cli(['recent', '-n', '1']);

		assert.match(stdout, new RegExp(`\\] ${id} `), '番号が出ていない');
		assert.doesNotMatch(stdout, /#\d/, '# つきの番号が残っている');
	});

	test('見出しの行に区切り・ルーム・番号・日時が並ぶ', async () => {
		// 本文が何十行あっても切れ目が分かるように、頭を 1 行にまとめてある
		const { stdout } = await cli(['recent', '-n', '1']);
		const line = stdout.split(/\r?\n/).find((l) => l.startsWith('────────'));

		assert.match(
			line,
			/^──────── \[[A-Za-z0-9_-]+\] m\d{6}-[0-9a-km-z]{2,} \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\.\d{3}/,
			`形が違う: [${line}]`
		);
	});

	test('仕組みからの発言にも同じ見出しが出る', async () => {
		/*
		 * 種別で出し分けると、読み手が「番号が無い行は何か」を考えることになる。
		 * join は参加の知らせを積む。見出しに差出人が付かないところだけが違う
		 */
		await cli(['join', wrapId('test-sys')]);
		const { stdout } = await cli(['recent', '-n', '3']);
		const lines = stdout.split(/\r?\n/);
		const at = lines.findIndex((l) => l.includes('test-sys が参加しました'));

		assert.ok(at > 0, '仕組みからの発言が無い');
		assert.match(
			lines[at - 1],
			/^──────── \[[A-Za-z0-9_-]+\] m\d{6}-[0-9a-km-z]{2,} \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/,
			`形が違う: [${lines[at - 1]}]`
		);
	});
});

describe('返信', () => {
	test('--reply-to に msg_id を渡すと親の番号が残る', async () => {
		const parent = await say('test-a', '親の発言');
		await say('test-b', '返答です', ['--reply-to', parent]);

		const { stdout } = await cli(['recent', '-n', '1']);
		assert.match(stdout, new RegExp(`↳${parent}`), '返信先が出ていない');
		assert.doesNotMatch(stdout, /↳#/);
	});

	test('今までの番号 (#2031 と 2031) も受けつづけ、表示は msg_id になる', async () => {
		const parent = await say('test-a', 'もう 1 つの親');
		const seq = await seqOf(parent);
		for (const form of [`#${seq}`, String(seq)]) {
			await say('test-b', `旧形式 ${form}`, ['--reply-to', form]);
			const { stdout } = await cli(['recent', '-n', '1']);
			assert.match(stdout, new RegExp(`↳${parent}`), form);
		}
	});

	test('--to と併用できる', async () => {
		// 誰に・どれへ、の両方を持てる
		const parent = await say('test-a', '名指しの親');
		await say('test-b', '名指しの返答', ['--to', wrapId('test-a'), '--reply-to', parent]);

		const { stdout } = await cli(['recent', '-n', '1']);
		assert.match(stdout, new RegExp(`test-b @test-a ↳${parent}\\r?\\n名指しの返答`));
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
		assert.match(stdout, new RegExp(`↳${notYet}`));
		assert.doesNotMatch(stdout, /↳#/);
	});
});

describe('誤りは断る', () => {
	test('発言番号の形でなければ終了コード 2 で止まり、新しい形を案内する', async () => {
		for (const bad of ['あ', 'm26-0c', 'm261117-0l', 'M261117-0c']) {
			const { code, stderr } = await failing(['say', wrapId('test-a'), '本文', '--reply-to', bad]);

			assert.equal(code, 2, bad);
			assert.match(stderr, /発言番号/);
			assert.match(stderr, /m261117-0c の形で出ています/);
			assert.doesNotMatch(stderr, /#474/);
		}
	});

	test('無い msg_id はサーバーが断り、終了コード 1 になる', async () => {
		const { code } = await failing(['say', wrapId('test-a'), '本文', '--reply-to', 'm000101-01']);
		assert.equal(code, 1);
	});

	test('nn の桁数が合わない番号は、サーバーへ送らず終了コード 2 で止まる (i261117-01)', async () => {
		// サーバーの parseMsgId は、桁数が「先頭の z の数 × 2 + 2」に合うかまで見る。クライアントも同じに見る
		for (const bad of ['m261117-000', 'm261117-z00', 'm261117-zz00', 'm261117-z0000']) {
			const { code, stderr } = await failing(['say', wrapId('test-a'), '本文', '--reply-to', bad]);

			assert.equal(code, 2, bad);
			assert.match(stderr, /発言番号/);
		}
	});

	test('桁があふれる数字は、精度が落ちた数を送らず終了コード 2 で止まる (i261117-01)', async () => {
		for (const bad of ['99999999999999999999', '9007199254740993']) {
			const { code } = await failing(['say', wrapId('test-a'), '本文', '--reply-to', bad]);
			assert.equal(code, 2, `${bad} が断られていない`);
		}
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
