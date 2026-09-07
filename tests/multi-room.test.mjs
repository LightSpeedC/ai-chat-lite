/*
 * 1 本の待受けで複数のルームを待つ。
 *
 * 【なぜまとめるのか】
 * ルームごとに 1 プロセスだと、2 つ見るのに 2 本立つ。待受けは 12 時間居座り、
 * 背面のコマンドは空きメモリが減ると刈られる。刈られるたびに読んで張り直す手間も
 * 2 倍になる。減らしたいのは本数そのものより、この往復である。
 *
 * 【なぜ位置をルームごとに持つのか】
 * cursors は (connector_id, room_id) の組で持っている。まとめて待っても、読むのも
 * 進めるのもルームごとになる。片方に届いたときにもう片方まで進めると、進めた分を
 * 取りこぼす。
 *
 * 【なぜ since を断るのか】
 * since は数 1 つなので、複数のルームを表せない。受け付けたままにすると、片方の
 * 番号でもう片方を読むことになり、取りこぼしか読み直しのどちらかが起きる。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { prepareTestDb } from './helpers/prepare-db.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const TEST_DATA = join(here, '..', 'tmp', '_data', 'unit-multi-room');

process.env.AICHAT_NO_EXIT = '1';
await prepareTestDb(TEST_DATA);

const { startServers, stopServers } = await import('../src/server/server.mjs');
const { TEST_ACCESS_TOKEN } = await import('../src/server/config.mjs');

let servers;
let base;

const HEADERS = { 'content-type': 'application/json', 'X-AiChat-Access-Token': TEST_ACCESS_TOKEN };

function api(path) {
	return fetch(`${base}${path}`, { headers: { 'X-AiChat-Access-Token': TEST_ACCESS_TOKEN } });
}

function say(roomId, body) {
	return fetch(`${base}/api/say`, {
		method: 'POST',
		headers: HEADERS,
		body: JSON.stringify({ from_connector_id: 'test-writer', room_id: roomId, msg_body: body }),
	}).then((r) => r.json());
}

/** 少し待ってから積む。待受けが待ちに入ったあとに届かせる */
function laterSay(roomId, body, delayMs = 400) {
	setTimeout(() => say(roomId, body).catch(() => {}), delayMs).unref?.();
}

/** その参加者の位置を、両方のルームで今の最後まで進める */
async function catchUp(connectorId) {
	await api(`/api/poll?connector_id=${connectorId}&room_id=alpha,beta&wait=0`);
}

before(async () => {
	servers = await startServers(0, ['127.0.0.1']);
	base = `http://127.0.0.1:${servers[0].address().port}`;
	// 2 つのルームに 1 件ずつ置いて、どちらも存在する状態から始める
	await say('alpha', 'alpha の 1 件目');
	await say('beta', 'beta の 1 件目');
});

after(async () => {
	await stopServers(servers);
});

describe('複数のルームを待つ', () => {
	test('カンマ区切りで渡すと、両方のルームが返る', async () => {
		const res = await api('/api/poll?connector_id=test-a&room_id=alpha,beta&wait=0');
		const json = await res.json();

		assert.equal(res.status, 200);
		assert.deepEqual(
			json.rooms.map((r) => r.room_id),
			['alpha', 'beta']
		);
	});

	test('1 つだけ渡したときは、これまでと同じ形も返る', async () => {
		// 既存の呼び出しを壊さないため、room_id / since / msg_seq を添える
		const res = await api('/api/poll?connector_id=test-b&room_id=alpha&wait=0');
		const json = await res.json();

		assert.equal(json.room_id, 'alpha');
		assert.equal(typeof json.since, 'number');
		assert.equal(typeof json.msg_seq, 'number');
	});

	test('複数のときは、これまでの形を添えない', async () => {
		// 1 つの数では表せないものを 1 つの数で返すと、読む側が取り違える
		const res = await api('/api/poll?connector_id=test-c&room_id=alpha,beta&wait=0');
		const json = await res.json();

		assert.equal(json.room_id, undefined);
		assert.equal(json.msg_seq, undefined);
	});

	test('同じルームを 2 回渡しても 1 つに畳む', async () => {
		const res = await api('/api/poll?connector_id=test-d&room_id=alpha,alpha&wait=0');
		const json = await res.json();

		assert.equal(json.rooms.length, 1);
		assert.equal(json.room_id, 'alpha', '1 つに畳んだので、これまでの形も添わる');
	});

	test('どちらか 1 つに届けば返る', async () => {
		await catchUp('test-e');
		laterSay('beta', 'beta へ届いた');

		const res = await api('/api/poll?connector_id=test-e&room_id=alpha,beta&wait=5');
		const json = await res.json();

		assert.equal(json.messages.length, 1);
		assert.equal(json.messages[0].room_id, 'beta');
	});
});

describe('位置はルームごとに進む', () => {
	test('片方に届いても、もう片方の位置は動かない', async () => {
		await catchUp('test-f');
		const before = await (await api('/api/poll?connector_id=test-f&room_id=alpha,beta&wait=0')).json();
		const alphaBefore = before.rooms.find((r) => r.room_id === 'alpha').msg_seq;

		await say('beta', 'beta だけに積む');
		const after = await (await api('/api/poll?connector_id=test-f&room_id=alpha,beta&wait=0')).json();

		const alphaAfter = after.rooms.find((r) => r.room_id === 'alpha').msg_seq;
		const betaAfter = after.rooms.find((r) => r.room_id === 'beta').msg_seq;

		assert.equal(alphaAfter, alphaBefore, 'alpha の位置まで動いている');
		assert.ok(betaAfter > alphaAfter, 'beta の位置が進んでいない');
	});

	test('まとめて待ったあとも、1 つずつ待てば続きから届く', async () => {
		await catchUp('test-g');
		await say('alpha', 'alpha へ 1 件');

		// まとめて受け取ると、alpha の位置だけが進む
		const both = await (await api('/api/poll?connector_id=test-g&room_id=alpha,beta&wait=0')).json();
		assert.equal(both.messages.length, 1);

		// 続けて alpha だけを見ると、もう新着は無い
		const again = await (await api('/api/poll?connector_id=test-g&room_id=alpha&wait=0')).json();
		assert.equal(again.messages.length, 0);
	});
});

describe('since は複数と噛み合わない', () => {
	test('複数のルームに since を渡すと 400 で断る', async () => {
		const res = await api('/api/poll?connector_id=test-h&room_id=alpha,beta&since=1&wait=0');

		assert.equal(res.status, 400);
		const json = await res.json();
		assert.match(json.error, /since/);
	});

	test('1 つなら since は今までどおり効く', async () => {
		const res = await api('/api/poll?connector_id=test-h&room_id=alpha&since=0&wait=0');
		const json = await res.json();

		assert.equal(res.status, 200);
		assert.ok(json.messages.length > 0, '先頭から読み直せていない');
	});

	test('空の since は渡していないものとして扱う', async () => {
		const res = await api('/api/poll?connector_id=test-i&room_id=alpha,beta&since=&wait=0');

		assert.equal(res.status, 200);
	});
});

describe('誤りは断る', () => {
	test('区切りの間が空だと断る', async () => {
		const res = await api('/api/poll?connector_id=test-j&room_id=alpha,,beta&wait=0');

		assert.equal(res.status, 400);
	});

	test('使えない文字は断る', async () => {
		const res = await api('/api/poll?connector_id=test-j&room_id=alpha,be%20ta&wait=0');

		assert.equal(res.status, 400);
	});
});
