import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const TEST_DATA = join(here, '..', 'tmp', '_data', 'unit-maintenance-handler');

// 本番の置き場を触らないよう、読み込む前に差し替える。
// config.mjs は読み込んだ時点で置き場を確定するため、import より先に置く
process.env.AICHAT_DATA = TEST_DATA;
rmSync(TEST_DATA, { recursive: true, force: true });
mkdirSync(TEST_DATA, { recursive: true });

const { readMaintenanceInfo, MAINTENANCE_FILE } = await import('../src/server/maintenance.mjs');
const { createMaintenanceHandler } = await import('../src/server/maintenance-handler.mjs');
const { startListening, setHandler, closeListening } = await import('../src/server/listen.mjs');

describe('印から読み取るもの', () => {
	test('理由だけ書いたときは見込みが null になる', () => {
		writeFileSync(MAINTENANCE_FILE, 'DB を作り直しています', 'utf8');
		const info = readMaintenanceInfo();

		assert.equal(info.reason, 'DB を作り直しています');
		// 分からないものは書かない。当てにされて外れるため
		assert.equal(info.minutes, null);
		assert.ok(info.since instanceof Date);
	});

	test('「見込み: N 分」の行を見込みとして読み、理由からは外す', () => {
		writeFileSync(MAINTENANCE_FILE, 'DB を作り直しています\n見込み: 3 分', 'utf8');
		const info = readMaintenanceInfo();

		assert.equal(info.minutes, 3);
		assert.equal(info.reason, 'DB を作り直しています');
		assert.doesNotMatch(info.reason, /見込み/);
	});

	test('印が無ければ空で返る', () => {
		rmSync(MAINTENANCE_FILE, { force: true });
		const info = readMaintenanceInfo();

		assert.equal(info.reason, '');
		assert.equal(info.minutes, null);
		assert.equal(info.since, null);
	});
});

describe('メンテナンス中の応答', () => {
	let servers;
	let base;

	before(async () => {
		servers = await startListening(
			createMaintenanceHandler({ reason: 'DB を作り直しています', retryAfterSec: 180, since: '2026-09-01T00:00:00.000Z' }),
			0,
			['127.0.0.1']
		);
		base = `http://127.0.0.1:${servers[0].address().port}`;
	});

	after(async () => {
		await closeListening(servers);
	});

	test('状態を尋ねる口は 200 で答える', async () => {
		const res = await fetch(`${base}/api/version`);
		const json = await res.json();

		assert.equal(res.status, 200);
		assert.equal(json.maintenance, true);
		assert.equal(json.maintenance_since, '2026-09-01T00:00:00.000Z');
	});

	test('状態を尋ねる口は理由も返す', async () => {
		// 隠すほどのものではない。画面が「なぜ止まっているか」を出せる方が親切
		const json = await (await fetch(`${base}/api/version`)).json();

		assert.equal(json.maintenance_reason, 'DB を作り直しています');
	});

	test('ほかの API は 503 で、理由と Retry-After を返す', async () => {
		for (const path of ['/api/users', '/api/poll', '/api/rooms']) {
			const res = await fetch(`${base}${path}`);
			const json = await res.json();

			assert.equal(res.status, 503, `${path} が 503 でない`);
			assert.equal(res.headers.get('retry-after'), '180', `${path} に Retry-After が無い`);
			assert.equal(json.error, 'メンテナンス中です');
			assert.equal(json.detail, 'DB を作り直しています');
		}
	});

	test('POST も 503 になる', async () => {
		const res = await fetch(`${base}/api/say`, { method: 'POST', body: '{}' });

		assert.equal(res.status, 503);
	});

	test('画面は 200 で返す', async () => {
		// HTML は返し、中で /api/version を見て「メンテナンス中」を出す
		const res = await fetch(`${base}/`);

		assert.equal(res.status, 200);
		assert.match(res.headers.get('content-type'), /text\/html/);
	});

	test('見込みが渡されなければ Retry-After は 60 になる', async () => {
		const local = await startListening(createMaintenanceHandler({ reason: '' }), 0, ['127.0.0.1']);
		const url = `http://127.0.0.1:${local[0].address().port}/api/users`;
		try {
			const res = await fetch(url);

			assert.equal(res.headers.get('retry-after'), '60');
			assert.equal((await res.json()).detail, 'しばらくお待ちください');
		} finally {
			await closeListening(local);
		}
	});
});

describe('受け口の差し替え', () => {
	let servers;
	let base;
	let port;

	before(async () => {
		servers = await startListening(createMaintenanceHandler({ reason: '作業中' }), 0, ['127.0.0.1']);
		port = servers[0].address().port;
		base = `http://127.0.0.1:${port}`;
	});

	after(async () => {
		await closeListening(servers);
	});

	test('差し替えても同じポートのまま繋がる', async () => {
		/*
		 * 別のサーバーを立てて差し替えると、閉じてから開くまでの間にポートが空く。
		 * その隙に繋いだ側は ECONNREFUSED を受け、メンテナンスと区別できない。
		 */
		assert.equal((await fetch(`${base}/api/users`)).status, 503);

		setHandler(servers, (req, res) => {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end('{"ok":true}');
		});

		assert.equal(servers[0].address().port, port, 'ポートが変わっている');

		const res = await fetch(`${base}/api/users`);
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { ok: true });
	});

	test('古い受け口は呼ばれなくなる', async () => {
		let oldCalled = false;
		setHandler(servers, (req, res) => {
			oldCalled = true;
			res.end('old');
		});
		setHandler(servers, (req, res) => res.end('new'));

		const text = await (await fetch(`${base}/api/users`)).text();

		assert.equal(text, 'new');
		assert.equal(oldCalled, false, '古い受け口が残っている');
	});
});
