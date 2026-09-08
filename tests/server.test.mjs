import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { prepareTestDb } from './helpers/prepare-db.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const TEST_DATA = join(here, '..', 'tmp', '_data', 'unit-server');

// 版を当ててから store を読み込む（store.mjs は形を作らない）
// admin/exit を叩いてもテストのプロセスを落とさない
process.env.AICHAT_NO_EXIT = '1';
// 離脱を積むまでの猶予。既定の 5 秒だとテストが待たされる
process.env.AICHAT_LEAVE_GRACE_MS = '150';
await prepareTestDb(TEST_DATA);

const { startServers, stopServers, sweepOffline } = await import('../src/server/server.mjs');
const hub = await import('../src/server/hub.mjs');
const store = await import('../src/server/store.mjs');
const { jstBefore } = await import('../src/server/time.mjs');
const { TEST_ACCESS_TOKEN } = await import('../src/server/config.mjs');

let servers;
let base;

before(async () => {
	// ポート 0 で起動すると空いているポートが割り当てられる。固定ポートだと
	// 開発中のサーバーとぶつかる
	servers = await startServers(0, ['127.0.0.1']);
	base = `http://127.0.0.1:${servers[0].address().port}`;
});

after(async () => {
	await stopServers(servers);
});

/*
 * 合図を付けて叩く。
 *
 * このテストは置き場を差し替えて動くのでテスト用として立ち、
 * サーバーは合図を持たない相手を断る。付けないと 403 になる。
 */
const AUTH = { 'X-AiChat-Access-Token': TEST_ACCESS_TOKEN };

async function post(path, body) {
	const res = await fetch(base + path, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...AUTH },
		body: JSON.stringify(body),
	});
	return { status: res.status, json: await res.json() };
}

async function get(path) {
	const res = await fetch(base + path, { headers: AUTH });
	return { status: res.status, json: await res.json() };
}

test('join すると現在位置と参加者一覧が返る', async () => {
	const { status, json } = await post('/api/join', { connector_id: 'test-connector1', connector_role: 'ai' });
	assert.equal(status, 200);
	assert.equal(json.connector_id, 'test-connector1');
	assert.equal(json.room_id, 'public');
	assert.ok(json.msg_seq >= 1, '参加を知らせるメッセージが積まれている');
	assert.equal(json.connectors.length, 1);
	// join は登録するだけで接続は張らない（接続を張るのは poll と events）。
	// このため直後は grace になる。オフラインではない
	assert.equal(json.connectors[0].status, 'grace');
	assert.equal(json.connectors[0].online, true);
	assert.equal(json.connectors[0].connected, false);
});

test('参加はログにも残る', async () => {
	const { json } = await get('/api/history?limit=10');
	const joined = json.messages.find((m) => m.msg_kind === 'join');
	assert.ok(joined, 'join のメッセージが無い');
	assert.equal(joined.msg_body, 'test-connector1 が参加しました');
});

test('say で投稿できる', async () => {
	const { status, json } = await post('/api/say', {
		from_connector_id: 'test-connector1',
		msg_body: '変換が通りました',
	});
	assert.equal(status, 200);
	assert.equal(json.from_connector_id, 'test-connector1');
	assert.equal(json.msg_kind, 'say');
	assert.equal(json.room_id, 'public');
	assert.equal(json.to_connector_id, null);
	assert.match(json.sent_at, /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
});

test('名指しできる', async () => {
	const { json } = await post('/api/say', {
		from_connector_id: 'test-connector1',
		to_connector_id: 'test-human',
		msg_body: '確認をお願いします',
	});
	assert.equal(json.to_connector_id, 'test-human');
});

test('poll は新着があれば待たずに返る', async () => {
	const started = Date.now();
	const { json } = await get('/api/poll?room_id=public&since=0&wait=10');
	assert.ok(json.messages.length > 0);
	assert.ok(Date.now() - started < 1000, '待たずに返るはず');
	assert.equal(json.msg_seq, json.messages[json.messages.length - 1].msg_seq);
});

test('poll は新着が無ければ待ち、投稿があると起きる', async () => {
	const { json: latest } = await get('/api/history?limit=1');
	const since = latest.messages[0].msg_seq;

	const started = Date.now();
	const polling = get(`/api/poll?connector_id=test-waiter&room_id=public&since=${since}&wait=10`);

	// 待ち始めたことを確かめてから投稿する
	await new Promise((r) => setTimeout(r, 150));
	assert.equal(hub.stats().waiters, 1, '待機に入っていない');

	await post('/api/say', { from_connector_id: 'test-connector1', msg_body: '起こします' });
	const { json } = await polling;

	assert.equal(json.messages.length, 1);
	assert.equal(json.messages[0].msg_body, '起こします');
	assert.ok(Date.now() - started < 5000, '投稿ですぐ起きるはず');
	assert.equal(hub.stats().waiters, 0, '待機が残っている');
});

test('poll は時間切れでも空で返る（着信なしと区別できる）', async () => {
	const { json: latest } = await get('/api/history?limit=1');
	const since = latest.messages[0].msg_seq;

	const started = Date.now();
	const { status, json } = await get(`/api/poll?room_id=public&since=${since}&wait=1`);

	assert.equal(status, 200);
	assert.deepEqual(json.messages, []);
	assert.equal(json.msg_seq, since, 'カーソルは進まない');
	assert.ok(Date.now() - started >= 900, '指定した秒数は待つ');
});

test('待っている間はオンライン扱いになる', async () => {
	const polling = get('/api/poll?connector_id=test-waiter&room_id=public&since=99999&wait=2');
	await new Promise((r) => setTimeout(r, 150));

	const { json } = await get('/api/connectors');
	const waiter = json.connectors.find((u) => u.connector_id === 'test-waiter');
	assert.equal(waiter.status, 'online');
	assert.equal(waiter.connected, true);

	await polling;

	const { json: after } = await get('/api/connectors');
	const gone = after.connectors.find((c) => c.connector_id === 'test-waiter');
	assert.equal(gone.connected, false, '待機が終われば接続は無い');
	assert.equal(gone.status, 'grace', 'ただし猶予の内なのでオフラインではない');
});

/*
 * 【なぜ必要か】
 * close は印を付けるだけで、接続を戻すのは待ち終えた後の finally だった。
 * そのルームに新着が無ければ最大 240 秒はそのまま数えられ、オフラインに
 * なるのは猶予 90 秒を足した 330 秒後になる。「90 秒でオフライン」を読んだ
 * 相手が、生死を読み違える。
 */
test('待受けを切れば、待ち切る前に接続が外れる', async () => {
	// get() は signal を取らないので、ここだけ fetch を直に使う
	const controller = new AbortController();
	const polling = fetch(`${base}/api/poll?connector_id=test-cut&room_id=public&since=99999&wait=10`, {
		headers: AUTH,
		signal: controller.signal,
	}).catch(() => {});
	await new Promise((r) => setTimeout(r, 150));

	const { json } = await get('/api/connectors');
	const before = json.connectors.find((u) => u.connector_id === 'test-cut');
	assert.equal(before.connected, true, '待っている間は接続として数える');

	assert.ok(hub.stats().waiters >= 1, '待機が hub に入っている');

	controller.abort();
	await polling;
	// 切れたことがサーバーに届くのを待つ。待ち切る 10 秒よりずっと短い
	await new Promise((r) => setTimeout(r, 250));

	const { json: after } = await get('/api/connectors');
	const cut = after.connectors.find((c) => c.connector_id === 'test-cut');
	assert.equal(cut.connected, false, '切っても接続として数え続けている');
	assert.equal(cut.status, 'grace', '猶予の内なのでオフラインにはしない');
	assert.equal(hub.stats().waiters, 0, '切れても待機が hub に居座っている');
});

test('別のルームには届かない', async () => {
	// ルーム名の接頭辞は sandbox-（テストデータの規約）
	await post('/api/say', { room_id: 'sandbox-other', from_connector_id: 'test-connector1', msg_body: '別室' });
	const { json } = await get('/api/history?room_id=sandbox-other&limit=10');
	assert.equal(json.messages.length, 1);
	assert.equal(json.messages[0].msg_body, '別室');
});

describe('片付けたものの見え方', () => {
	/*
	 * history と dump で見え方が違うことを確かめる。
	 *
	 * history は読むための道なので片付けたものを出さない。dump は中身を
	 * 確かめるためのものなので出す。同じ入口に旗で分けると、旗の付け忘れで
	 * 読む側に混ざる。
	 */
	let seq;

	before(async () => {
		await post('/api/say', {
			room_id: 'sandbox-archived',
			from_connector_id: 'test-connector1',
			msg_body: '片付ける発言',
		});
		const { json } = await post('/api/admin/archive', {
			kind: 'room',
			id: 'sandbox-archived',
			connector_id: 'test-connector1',
			confirm: 'sandbox-archived',
			description: '対象が消えない説明',
		});
		seq = json.archived_seq;
	});

	test('history には出ない', async () => {
		const { json } = await get('/api/history?room_id=sandbox-archived&limit=10');
		assert.deepEqual(json.messages, []);
	});

	test('dump には出る。ルームで絞らず全件返る', async () => {
		const { status, json } = await get('/api/dump');
		assert.equal(status, 200);
		assert.equal(json.count, json.messages.length);

		const gone = json.messages.filter((m) => m.room_id === 'sandbox-archived');
		assert.equal(gone.length, 1, 'dump から消えている');
		assert.equal(gone[0].archived_seq, seq, 'archived_seq が入っていない');

		// 全ルームが混ざっていること（room_id で絞っていない）
		assert.ok(new Set(json.messages.map((m) => m.room_id)).size >= 2);
	});

	test('片付けの知らせが、どの操作かを持っている', async () => {
		/*
		 * 画面はこの番号を見て「戻す」ボタンを出す。本文は --description で
		 * 書き換えられるため、番号を本文から拾うことはできない。
		 */
		const { json } = await get('/api/history?room_id=public&limit=20');
		const notice = json.messages.filter((m) => m.msg_kind === 'archive').pop();

		assert.ok(notice, 'archive の知らせが無い');
		assert.equal(notice.ref_archived_seq, seq);
		assert.equal(notice.archived_seq, null, '知らせ自身は片付けられていない');
	});

	test('archives には対象が説明とは別に残る', async () => {
		const { json } = await get('/api/admin/archives');
		const row = json.archives.find((a) => a.archived_seq === seq);

		assert.equal(row.archive_kind, 'room');
		assert.equal(row.archive_id, 'sandbox-archived');
		assert.equal(row.description, '対象が消えない説明');
	});

	test('戻せば history に出る', async () => {
		await post('/api/admin/restore', { archived_seq: seq, connector_id: 'test-connector1' });
		const { json } = await get('/api/history?room_id=sandbox-archived&limit=10');
		assert.equal(json.messages.length, 1);
	});
});

test('history は before で遡れる', async () => {
	const { json: all } = await get('/api/history?limit=100');
	const third = all.messages[2].msg_seq;

	const { json } = await get(`/api/history?before=${third}&limit=100`);
	assert.ok(json.messages.every((m) => m.msg_seq < third));
	assert.deepEqual(
		json.messages.map((m) => m.msg_seq),
		all.messages.filter((m) => m.msg_seq < third).map((m) => m.msg_seq)
	);
});

test('leave は猶予のあとログに残る', async () => {
	const { status, json: res } = await post('/api/leave', { connector_id: 'test-connector1' });
	assert.equal(status, 200);
	assert.equal(res.grace_ms, 150);

	// 猶予の前は積まれていない
	const before = await get('/api/history?limit=1');
	assert.notEqual(before.json.messages[0]?.msg_body, 'test-connector1 が離脱しました');

	await new Promise((r) => setTimeout(r, 300));

	const { json } = await get('/api/history?limit=1');
	assert.equal(json.messages[0].msg_kind, 'leave');
	assert.equal(json.messages[0].msg_body, 'test-connector1 が離脱しました');
});

test('猶予のうちに戻ってきたら離脱を積まない', async () => {
	/*
	 * 画面のリロードがこれに当たる。pagehide は閉じたときだけでなく
	 * リロードでも起きるため、呼ばれた時点で積むと並んでしまう。
	 * 実測でリロード 3 回につき 3 件積まれていた。
	 */
	const connectorId = 'reloader';
	await post('/api/join', { connector_id: connectorId, connector_role: 'human' });

	const before = (await get('/api/history?limit=500')).json.messages.filter(
		(m) => m.msg_kind === 'leave' && m.from_connector_id === connectorId
	).length;

	await post('/api/leave', { connector_id: connectorId });
	// すぐ繋ぎ直す。リロードでは 1 秒ほどで戻ってくる
	store.addConnection(connectorId);

	await new Promise((r) => setTimeout(r, 300));

	const after = (await get('/api/history?limit=500')).json.messages.filter(
		(m) => m.msg_kind === 'leave' && m.from_connector_id === connectorId
	).length;
	assert.equal(after, before, '戻ってきたのに離脱が積まれている');

	store.removeConnection(connectorId);
});

test('SSE で受け取れる', async () => {
	const controller = new AbortController();
	const res = await fetch(`${base}/api/events?connector_id=browser&room_id=public&since=99999`, {
		signal: controller.signal,
		headers: AUTH,
	});
	assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';

	/** 指定したイベントが届くまで読む */
	async function readEvent(name) {
		while (!buffer.includes(`event: ${name}`)) {
			const { value, done } = await reader.read();
			if (done) throw new Error('切断された');
			buffer += decoder.decode(value, { stream: true });
		}
		const block = buffer.split('\n\n').find((b) => b.includes(`event: ${name}`));
		return JSON.parse(block.split('data: ')[1]);
	}

	// 接続した直後に在席が流れてくる
	const presence = await readEvent('presence');
	assert.ok(Array.isArray(presence));

	await post('/api/say', { from_connector_id: 'test-connector1', msg_body: 'SSE のテスト' });
	const message = await readEvent('message');
	assert.equal(message.msg_body, 'SSE のテスト');

	controller.abort();
});

test('connector_id が無いと 400', async () => {
	const { status, json } = await post('/api/join', {});
	assert.equal(status, 400);
	assert.match(json.error, /connector_id/);
});

test('空の本文は 400', async () => {
	const { status } = await post('/api/say', { from_connector_id: 'test-x', msg_body: '' });
	assert.equal(status, 400);
});

test('長すぎる本文は 400', async () => {
	const { status } = await post('/api/say', { from_connector_id: 'test-x', msg_body: 'a'.repeat(32001) });
	assert.equal(status, 400);
});

test('不正な connector_role は 400', async () => {
	const { status } = await post('/api/join', { connector_id: 'test-x', connector_role: 'robot' });
	assert.equal(status, 400);
});

test('壊れた JSON は 400', async () => {
	const res = await fetch(base + '/api/say', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...AUTH },
		body: '{壊れている',
	});
	assert.equal(res.status, 400);
});

test('知らないパスは 404', async () => {
	const { status } = await get('/api/unknown');
	assert.equal(status, 404);
});

test('exit は既定で終了コード 1（再起動される側）', async () => {
	// 取り違えたときの被害が小さい方を既定にしている。
	// 0 で止めてしまうと、動かし直すのに管理者権限が要る
	const { status, json } = await post('/api/admin/exit', { connector_id: 'test-tester' });
	assert.equal(status, 200);
	assert.equal(json.exit_code, 1);
	assert.match(json.note, /起動し直します|このまま終了します/);
});

test('exit_code 0 は再起動されない', async () => {
	const { json } = await post('/api/admin/exit', { connector_id: 'test-tester', exit_code: 0 });
	assert.equal(json.exit_code, 0);
	assert.equal(json.will_restart, false);
});

test('サービス経由でなければ再起動されないと分かる', async () => {
	// テストは直接起動なので AICHAT_MANAGED が無い
	const { json } = await post('/api/admin/exit', { connector_id: 'test-tester', exit_code: 1 });
	assert.equal(json.managed_by, null);
	assert.equal(json.will_restart, false, 'サービス経由でなければ落ちるだけ');
});

test('範囲外の終了コードは 400', async () => {
	assert.equal((await post('/api/admin/exit', { exit_code: 999 })).status, 400);
	assert.equal((await post('/api/admin/exit', { exit_code: -1 })).status, 400);
});

test('GET でも叩ける（ブラウザのアドレスバーから）', async () => {
	const { status, json } = await get('/api/admin/exit?exit_code=1&connector_id=browser');
	assert.equal(status, 200);
	assert.equal(json.exit_code, 1);
});

test('GET でも exit_code は効く', async () => {
	const { json } = await get('/api/admin/exit?exit_code=0');
	assert.equal(json.exit_code, 0);
	assert.equal(json.will_restart, false);
});

test('GET で省略すると既定の 1', async () => {
	// URL のクエリは省略されると null になり、Number(null) は 0 になってしまう。
	// 素通しすると wait の省略が「0 秒待つ」になるため、null は fallback に倒す
	const { json } = await get('/api/admin/exit');
	assert.equal(json.exit_code, 1);
});

test('wait を省略しても即座に返らない（既定が効いている）', async () => {
	const { json: latest } = await get('/api/history?limit=1');
	const since = latest.messages[0].msg_seq;

	const started = Date.now();
	const polling = get(`/api/poll?room_id=public&since=${since}`);

	// 0 秒待ちになっていれば、ここで既に返ってしまっている
	await new Promise((r) => setTimeout(r, 400));
	assert.equal(hub.stats().waiters, 1, 'wait の既定が効かず即座に返っている');

	// 投稿して起こし、待ちっぱなしにしない
	await post('/api/say', { from_connector_id: 'test-connector1', msg_body: '既定の wait を確かめる' });
	await polling;
	assert.ok(Date.now() - started < 5000);
});

test('web の外は参照できない', async () => {
	const res = await fetch(base + '/../../src/server/store.mjs');
	assert.ok(res.status === 403 || res.status === 404, `status=${res.status}`);
});

// --- どこまで読んだかをサーバーが覚える ---

test('since を省略すると、参加した時点から待つ', async () => {
	// 過去ログを流し込まないようにするため、初参加は「今から」になる
	await post('/api/join', { connector_id: 'test-reader', connector_role: 'ai' });
	const { json } = await get('/api/poll?connector_id=test-reader&wait=0');
	assert.deepEqual(json.messages, [], '過去のぶんは返らない');
});

test('受け取ったら位置が進み、次は続きから届く', async () => {
	await post('/api/say', { from_connector_id: 'test-connector1', msg_body: 'カーソルの確認 1' });

	const first = await get('/api/poll?connector_id=test-reader&wait=0');
	assert.equal(first.json.messages.length, 1);
	assert.equal(first.json.messages[0].msg_body, 'カーソルの確認 1');

	// 同じ呼び方でも、もう一度は返らない
	const again = await get('/api/poll?connector_id=test-reader&wait=0');
	assert.deepEqual(again.json.messages, [], '受け取った分が繰り返し返っている');

	await post('/api/say', { from_connector_id: 'test-connector1', msg_body: 'カーソルの確認 2' });
	const next = await get('/api/poll?connector_id=test-reader&wait=0');
	assert.equal(next.json.messages.length, 1);
	assert.equal(next.json.messages[0].msg_body, 'カーソルの確認 2');
});

test('位置はルームごとに別々', async () => {
	await post('/api/say', { room_id: 'dev', from_connector_id: 'test-connector1', msg_body: 'dev の発言' });

	// public 側の位置は進んでいるが、dev は初めてなので参加時点から
	const dev = await get('/api/poll?connector_id=test-reader&room_id=dev&wait=0');
	assert.deepEqual(dev.json.messages, [], 'dev は初めてなので今から');

	await post('/api/say', { room_id: 'dev', from_connector_id: 'test-connector1', msg_body: 'dev の 2 つ目' });
	const devNext = await get('/api/poll?connector_id=test-reader&room_id=dev&wait=0');
	assert.equal(devNext.json.messages.length, 1);
	assert.equal(devNext.json.messages[0].msg_body, 'dev の 2 つ目');
});

test('since を明示すれば、そちらが優先される', async () => {
	// ブラウザは自分で位置を持っているため、記録に左右されない
	const { json } = await get('/api/poll?connector_id=test-reader&since=0&wait=0');
	assert.ok(json.messages.length > 1, '記録を無視して 0 から返るはず');
});

test('connector_id が無ければ記録しない', async () => {
	const a = await get('/api/poll?since=0&wait=0');
	const b = await get('/api/poll?since=0&wait=0');
	assert.equal(a.json.messages.length, b.json.messages.length, '毎回同じ結果になる');
});

test('再び join しても位置は巻き戻らない', async () => {
	// 未読を飛ばさないため、すでに記録があれば触らない
	await post('/api/say', { from_connector_id: 'test-connector1', msg_body: '再 join の前' });
	await post('/api/join', { connector_id: 'test-reader', connector_role: 'ai' });

	const { json } = await get('/api/poll?connector_id=test-reader&wait=0');
	assert.equal(json.messages.length, 1);
	assert.equal(json.messages[0].msg_body, '再 join の前', '未読が飛ばされている');
});

// --- オフラインへ落ちたことの通知 ---

test('初めて見る相手には離脱を流さない', async () => {
	// 起動直後に、もともと居なかった全員分の離脱が流れるのを防ぐため
	store.joinConnector('test-ghost', 'ai');
	store.setLastActiveAt('test-ghost', jstBefore(300 * 1000));

	const gone = sweepOffline();
	assert.ok(!gone.includes('test-ghost'), '初回は対象外のはず');
});

test('オンラインから落ちた相手の離脱をログに積む', async () => {
	store.joinConnector('test-vanisher', 'ai');
	sweepOffline(); // ここで grace として覚える

	// 猶予を過ぎた状態にする
	store.setLastActiveAt('test-vanisher', jstBefore(300 * 1000));

	const gone = sweepOffline();
	assert.deepEqual(gone, ['test-vanisher']);

	const { json } = await get('/api/history?limit=1');
	assert.equal(json.messages[0].msg_kind, 'leave');
	assert.equal(json.messages[0].msg_body, 'test-vanisher がオフラインになりました');
});

test('落ちたままの相手を何度も流さない', async () => {
	// 状態が変わった瞬間だけを拾う。毎回流すとログが埋まる
	const gone = sweepOffline();
	assert.deepEqual(gone, []);
});

test('戻ってきてまた落ちれば、もう一度流す', async () => {
	store.setLastActiveAt('test-vanisher', jstBefore(0));
	sweepOffline(); // grace として覚え直す

	store.setLastActiveAt('test-vanisher', jstBefore(300 * 1000));
	const gone = sweepOffline();
	assert.deepEqual(gone, ['test-vanisher']);
});

/*
 * どちらの環境かを名乗る。
 *
 * 繋いだ側が自分の居場所を確かめられないと、本番へ向けたまま投稿してしまう。
 * このテストは AICHAT_DATA を差し替えて動いているので test になる。
 */
test('/api/version が環境を名乗る', async () => {
	const { json } = await get('/api/version');
	assert.equal(json.env, 'test', '置き場を差し替えているので test のはず');
	assert.ok(json.version, '版も返る');
});
