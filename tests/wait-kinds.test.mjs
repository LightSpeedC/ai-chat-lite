/*
 * 待受けを起こす種別のしぼり。
 *
 * 【なぜ絞るのか】
 * public には join と leave が数分ごとに流れる。既定のままだと 12 時間を指定しても
 * 数分で返っていた（実測 4 分）。ルールは「参加・離脱の記録は伝えない」なので、
 * 読まずに捨てるもので起こされていたことになる。
 *
 * 【なぜサーバー側で絞るのか】
 * CLI で受け取ってから捨てると、cmdWait の waited += wait が「待ち切った」前提で
 * 加算しているため、実際の経過より速く上限に達する。同じ症状が残る。
 *
 * 【なぜ除いた分もカーソルを進めるのか】
 * 止めると、張り直した先で同じ join を読み、また除いて待つ。1 回で済むはずの走査が
 * 毎回積み上がる。出入りは報告しない決まりなので、読み飛ばして構わない。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { prepareTestDb } from './helpers/prepare-db.mjs';
import { withId, wrapId } from './helpers/cli-args.mjs';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const TEST_DATA = join(here, '..', 'tmp', '_data', 'unit-wait-kinds');
const CLIENT = join(here, '..', 'src', 'client', 'chat.mjs');

process.env.AICHAT_NO_EXIT = '1';
await prepareTestDb(TEST_DATA);

const { startServers, stopServers } = await import('../src/server/server.mjs');
const { TEST_ACCESS_TOKEN } = await import('../src/server/config.mjs');

let servers;
let base;

function chat(args, connectorId = 'test-waiter') {
	return run(
		process.execPath,
		[CLIENT, ...withId(args, connectorId), '--url', base, '--access-token', TEST_ACCESS_TOKEN],
		{ env: { ...process.env } }
	);
}

/** API を直に叩く。CLI を通さないときの守りも確かめるため */
function api(path) {
	return fetch(`${base}${path}`, { headers: { 'X-AiChat-Access-Token': TEST_ACCESS_TOKEN } });
}

/** 少し待ってから積む。待受けが待ちに入ったあとに届かせる */
function laterSay(from, body, delayMs = 400) {
	setTimeout(() => {
		fetch(`${base}/api/say`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'X-AiChat-Access-Token': TEST_ACCESS_TOKEN },
			body: JSON.stringify({ from_connector_id: from, msg_body: body }),
		}).catch(() => {});
	}, delayMs).unref?.();
}

/** 少し待ってから参加させる（join の記録が積まれる） */
function laterJoin(id, delayMs = 400) {
	setTimeout(() => {
		fetch(`${base}/api/join`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'X-AiChat-Access-Token': TEST_ACCESS_TOKEN },
			body: JSON.stringify({ connector_id: id, connector_role: 'ai' }),
		}).catch(() => {});
	}, delayMs).unref?.();
}

before(async () => {
	servers = await startServers(0, ['127.0.0.1']);
	base = `http://127.0.0.1:${servers[0].address().port}`;
	await chat(['join']);
	// ここまでの記録を読み終えた状態にする。以降は新着なしから始まる
	await chat(['wait', '--wait-sec', '1']);
});

after(async () => {
	await stopServers(servers);
});

describe('既定では参加・離脱で起きない', () => {
	test('待っている間に join が積まれても返らない', async () => {
		laterJoin('test-newcomer');
		const { stdout } = await chat(['wait', '--wait-sec', '3']);

		assert.match(stdout, /新着なし/, `join で返ってしまった: ${stdout}`);
	});

	test('say なら返る', async () => {
		// 絞りが効きすぎて何も届かない、という壊れ方を捕まえる
		laterSay('test-other', '起きてください');
		const { stdout } = await chat(['wait', '--wait-sec', '5']);

		assert.match(stdout, /新着 1 件/);
		assert.match(stdout, /起きてください/);
	});

	test('開始の行に「参加・離脱も」が出ない', async () => {
		const { stdout } = await chat(['wait', '--wait-sec', '1']);

		assert.match(stdout, /pid \d+ で待受け中（最大/);
		assert.doesNotMatch(stdout, /参加・離脱も/);
	});
});

describe('--with-joins を付けたときは起きる', () => {
	test('join で返る', async () => {
		laterJoin('test-newcomer2');
		const { stdout } = await chat(['wait', '--wait-sec', '5', '--with-joins']);

		assert.match(stdout, /新着 1 件/, `join で返らなかった: ${stdout}`);
		assert.match(stdout, /参加しました/);
	});

	test('開始の行に「参加・離脱も」が出る', async () => {
		const { stdout } = await chat(['wait', '--wait-sec', '1', '--with-joins']);

		assert.match(stdout, /参加・離脱も/);
	});
});

describe('除いた分もカーソルは進む', () => {
	test('join をまたいで現在位置が進む', async () => {
		/*
		 * 進めないと、張り直した先で同じ join を読み、また除いて待つ。
		 * 新着なしで終わった待受けでも位置が進んでいることを確かめる。
		 */
		const before = await api('/api/poll?connector_id=test-cursor&room_id=public&wait=0').then((r) => r.json());

		await fetch(`${base}/api/join`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'X-AiChat-Access-Token': TEST_ACCESS_TOKEN },
			body: JSON.stringify({ connector_id: 'test-cursor-mover', connector_role: 'ai' }),
		});

		const res = await api('/api/poll?connector_id=test-cursor&room_id=public&wait=0&exclude=join,leave').then((r) => r.json());

		assert.equal(res.messages.length, 0, '除いたのに返ってきている');
		assert.ok(res.msg_seq > before.msg_seq, `位置が進んでいない: ${before.msg_seq} → ${res.msg_seq}`);
	});
});

describe('除くのは join と leave だけ', () => {
	test('片付けの知らせは既定でも返る', async () => {
		/*
		 * archive には画面で戻すボタンが付く。知らせを落とすと戻す口が見えなくなる。
		 *
		 * CLI の archive は対象名の入力を求めるため、ここでは API を直に叩く
		 * （子プロセスにすると標準入力を待って止まる）。
		 */
		const said = await chat(['say', 'これを片付けます']);
		const seq = Number(/送信しました（(\d+)）/.exec(said.stdout)[1]);

		// 位置を最新にしてから片付ける。archive の知らせだけを見たい
		await api('/api/poll?connector_id=test-arch&room_id=public&wait=0').then((r) => r.json());

		const res0 = await fetch(`${base}/api/admin/archive`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'X-AiChat-Access-Token': TEST_ACCESS_TOKEN },
			// confirm は誤って片付けるのを防ぐための復唱。id と同じ値を入れる
			body: JSON.stringify({ kind: 'message', id: String(seq), confirm: String(seq), connector_id: 'test-waiter', description: 'テストのため' }),
		});
		assert.equal(res0.status, 200, await res0.text());

		const res = await api('/api/poll?connector_id=test-arch&room_id=public&wait=0&exclude=join,leave').then((r) => r.json());
		const kinds = res.messages.map((m) => m.msg_kind);

		assert.ok(kinds.includes('archive'), `片付けの知らせが落ちている: ${kinds.join(' ')}`);
	});
});

describe('誤りは断る', () => {
	test('知らない種別は 400', async () => {
		const res = await api('/api/poll?room_id=public&wait=0&exclude=nosuch');

		assert.equal(res.status, 400);
		const body = await res.json();
		assert.match(body.error, /exclude/);
	});

	test('省略したら全部で起こす', async () => {
		/*
		 * 画面（SSE）と既存の呼び出しのために、既定の振る舞いは変えない。
		 * 絞るかどうかを決めるのは CLI 側である。
		 */
		await api('/api/poll?connector_id=test-all&room_id=public&wait=0').then((r) => r.json());

		await fetch(`${base}/api/join`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'X-AiChat-Access-Token': TEST_ACCESS_TOKEN },
			body: JSON.stringify({ connector_id: 'test-all-mover', connector_role: 'ai' }),
		});

		const res = await api('/api/poll?connector_id=test-all&room_id=public&wait=0').then((r) => r.json());
		const kinds = res.messages.map((m) => m.msg_kind);

		assert.ok(kinds.includes('join'), `join が届いていない: ${kinds.join(' ')}`);
	});

	test('空文字は「除かない」と同じ扱い', async () => {
		const res = await api('/api/poll?room_id=public&wait=0&exclude=');

		assert.equal(res.status, 200);
	});
});
