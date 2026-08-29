import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const TEST_DB = join(here, '..', 'tmp', 'test-server.db');

process.env.AICHAT_DB = TEST_DB;
// admin/exit を叩いてもテストのプロセスを落とさない
process.env.AICHAT_NO_EXIT = '1';
for (const suffix of ['', '-wal', '-shm']) rmSync(TEST_DB + suffix, { force: true });

const { startServers, stopServers, sweepOffline } = await import('../src/server/server.mjs');
const hub = await import('../src/server/hub.mjs');
const store = await import('../src/server/store.mjs');
const { jstBefore } = await import('../src/server/time.mjs');

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

async function post(path, body) {
	const res = await fetch(base + path, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	return { status: res.status, json: await res.json() };
}

async function get(path) {
	const res = await fetch(base + path);
	return { status: res.status, json: await res.json() };
}

test('join すると現在位置と参加者一覧が返る', async () => {
	const { status, json } = await post('/api/join', { user_id: 'html2md', user_role: 'ai' });
	assert.equal(status, 200);
	assert.equal(json.user_id, 'html2md');
	assert.equal(json.room_id, 'public');
	assert.ok(json.msg_seq >= 1, '参加を知らせるメッセージが積まれている');
	assert.equal(json.users.length, 1);
	// join は登録するだけで接続は張らない（接続を張るのは poll と events）。
	// このため直後は grace になる。オフラインではない
	assert.equal(json.users[0].status, 'grace');
	assert.equal(json.users[0].online, true);
	assert.equal(json.users[0].connected, false);
});

test('参加はログにも残る', async () => {
	const { json } = await get('/api/history?limit=10');
	const joined = json.messages.find((m) => m.msg_kind === 'join');
	assert.ok(joined, 'join のメッセージが無い');
	assert.equal(joined.msg_body, 'html2md が参加しました');
});

test('say で投稿できる', async () => {
	const { status, json } = await post('/api/say', {
		from_user_id: 'html2md',
		msg_body: '変換が通りました',
	});
	assert.equal(status, 200);
	assert.equal(json.from_user_id, 'html2md');
	assert.equal(json.msg_kind, 'say');
	assert.equal(json.room_id, 'public');
	assert.equal(json.to_user_id, null);
	assert.match(json.sent_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
});

test('名指しできる', async () => {
	const { json } = await post('/api/say', {
		from_user_id: 'html2md',
		to_user_id: 'human',
		msg_body: '確認をお願いします',
	});
	assert.equal(json.to_user_id, 'human');
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
	const polling = get(`/api/poll?user_id=waiter&room_id=public&since=${since}&wait=10`);

	// 待ち始めたことを確かめてから投稿する
	await new Promise((r) => setTimeout(r, 150));
	assert.equal(hub.stats().waiters, 1, '待機に入っていない');

	await post('/api/say', { from_user_id: 'html2md', msg_body: '起こします' });
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
	const polling = get('/api/poll?user_id=waiter&room_id=public&since=99999&wait=2');
	await new Promise((r) => setTimeout(r, 150));

	const { json } = await get('/api/users');
	const waiter = json.users.find((u) => u.user_id === 'waiter');
	assert.equal(waiter.status, 'online');
	assert.equal(waiter.connected, true);

	await polling;

	const { json: after } = await get('/api/users');
	const gone = after.users.find((u) => u.user_id === 'waiter');
	assert.equal(gone.connected, false, '待機が終われば接続は無い');
	assert.equal(gone.status, 'grace', 'ただし猶予の内なのでオフラインではない');
});

test('別のルームには届かない', async () => {
	await post('/api/say', { room_id: 'other', from_user_id: 'html2md', msg_body: '別室' });
	const { json } = await get('/api/history?room_id=other&limit=10');
	assert.equal(json.messages.length, 1);
	assert.equal(json.messages[0].msg_body, '別室');
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

test('leave でログに残る', async () => {
	const { status } = await post('/api/leave', { user_id: 'html2md' });
	assert.equal(status, 200);

	const { json } = await get('/api/history?limit=1');
	assert.equal(json.messages[0].msg_kind, 'leave');
	assert.equal(json.messages[0].msg_body, 'html2md が離脱しました');
});

test('SSE で受け取れる', async () => {
	const controller = new AbortController();
	const res = await fetch(`${base}/api/events?user_id=browser&room_id=public&since=99999`, {
		signal: controller.signal,
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

	await post('/api/say', { from_user_id: 'html2md', msg_body: 'SSE のテスト' });
	const message = await readEvent('message');
	assert.equal(message.msg_body, 'SSE のテスト');

	controller.abort();
});

test('user_id が無いと 400', async () => {
	const { status, json } = await post('/api/join', {});
	assert.equal(status, 400);
	assert.match(json.error, /user_id/);
});

test('空の本文は 400', async () => {
	const { status } = await post('/api/say', { from_user_id: 'x', msg_body: '' });
	assert.equal(status, 400);
});

test('長すぎる本文は 400', async () => {
	const { status } = await post('/api/say', { from_user_id: 'x', msg_body: 'a'.repeat(32001) });
	assert.equal(status, 400);
});

test('不正な user_role は 400', async () => {
	const { status } = await post('/api/join', { user_id: 'x', user_role: 'robot' });
	assert.equal(status, 400);
});

test('壊れた JSON は 400', async () => {
	const res = await fetch(base + '/api/say', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
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
	const { status, json } = await post('/api/admin/exit', { user_id: 'tester' });
	assert.equal(status, 200);
	assert.equal(json.exit_code, 1);
	assert.match(json.note, /起動し直します|このまま終了します/);
});

test('exit_code 0 は再起動されない', async () => {
	const { json } = await post('/api/admin/exit', { user_id: 'tester', exit_code: 0 });
	assert.equal(json.exit_code, 0);
	assert.equal(json.will_restart, false);
});

test('サービス経由でなければ再起動されないと分かる', async () => {
	// テストは直接起動なので AICHAT_MANAGED が無い
	const { json } = await post('/api/admin/exit', { user_id: 'tester', exit_code: 1 });
	assert.equal(json.managed_by, null);
	assert.equal(json.will_restart, false, 'サービス経由でなければ落ちるだけ');
});

test('範囲外の終了コードは 400', async () => {
	assert.equal((await post('/api/admin/exit', { exit_code: 999 })).status, 400);
	assert.equal((await post('/api/admin/exit', { exit_code: -1 })).status, 400);
});

test('GET でも叩ける（ブラウザのアドレスバーから）', async () => {
	const { status, json } = await get('/api/admin/exit?exit_code=1&user_id=browser');
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
	await post('/api/say', { from_user_id: 'html2md', msg_body: '既定の wait を確かめる' });
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
	await post('/api/join', { user_id: 'reader', user_role: 'ai' });
	const { json } = await get('/api/poll?user_id=reader&wait=0');
	assert.deepEqual(json.messages, [], '過去のぶんは返らない');
});

test('受け取ったら位置が進み、次は続きから届く', async () => {
	await post('/api/say', { from_user_id: 'html2md', msg_body: 'カーソルの確認 1' });

	const first = await get('/api/poll?user_id=reader&wait=0');
	assert.equal(first.json.messages.length, 1);
	assert.equal(first.json.messages[0].msg_body, 'カーソルの確認 1');

	// 同じ呼び方でも、もう一度は返らない
	const again = await get('/api/poll?user_id=reader&wait=0');
	assert.deepEqual(again.json.messages, [], '受け取った分が繰り返し返っている');

	await post('/api/say', { from_user_id: 'html2md', msg_body: 'カーソルの確認 2' });
	const next = await get('/api/poll?user_id=reader&wait=0');
	assert.equal(next.json.messages.length, 1);
	assert.equal(next.json.messages[0].msg_body, 'カーソルの確認 2');
});

test('位置はルームごとに別々', async () => {
	await post('/api/say', { room_id: 'dev', from_user_id: 'html2md', msg_body: 'dev の発言' });

	// public 側の位置は進んでいるが、dev は初めてなので参加時点から
	const dev = await get('/api/poll?user_id=reader&room_id=dev&wait=0');
	assert.deepEqual(dev.json.messages, [], 'dev は初めてなので今から');

	await post('/api/say', { room_id: 'dev', from_user_id: 'html2md', msg_body: 'dev の 2 つ目' });
	const devNext = await get('/api/poll?user_id=reader&room_id=dev&wait=0');
	assert.equal(devNext.json.messages.length, 1);
	assert.equal(devNext.json.messages[0].msg_body, 'dev の 2 つ目');
});

test('since を明示すれば、そちらが優先される', async () => {
	// ブラウザは自分で位置を持っているため、記録に左右されない
	const { json } = await get('/api/poll?user_id=reader&since=0&wait=0');
	assert.ok(json.messages.length > 1, '記録を無視して 0 から返るはず');
});

test('user_id が無ければ記録しない', async () => {
	const a = await get('/api/poll?since=0&wait=0');
	const b = await get('/api/poll?since=0&wait=0');
	assert.equal(a.json.messages.length, b.json.messages.length, '毎回同じ結果になる');
});

test('再び join しても位置は巻き戻らない', async () => {
	// 未読を飛ばさないため、すでに記録があれば触らない
	await post('/api/say', { from_user_id: 'html2md', msg_body: '再 join の前' });
	await post('/api/join', { user_id: 'reader', user_role: 'ai' });

	const { json } = await get('/api/poll?user_id=reader&wait=0');
	assert.equal(json.messages.length, 1);
	assert.equal(json.messages[0].msg_body, '再 join の前', '未読が飛ばされている');
});

// --- オフラインへ落ちたことの通知 ---

test('初めて見る相手には離脱を流さない', async () => {
	// 起動直後に、もともと居なかった全員分の離脱が流れるのを防ぐため
	store.joinUser('ghost', 'ai');
	store.setLastActiveAt('ghost', jstBefore(300 * 1000));

	const gone = sweepOffline();
	assert.ok(!gone.includes('ghost'), '初回は対象外のはず');
});

test('オンラインから落ちた相手の離脱をログに積む', async () => {
	store.joinUser('vanisher', 'ai');
	sweepOffline(); // ここで grace として覚える

	// 猶予を過ぎた状態にする
	store.setLastActiveAt('vanisher', jstBefore(300 * 1000));

	const gone = sweepOffline();
	assert.deepEqual(gone, ['vanisher']);

	const { json } = await get('/api/history?limit=1');
	assert.equal(json.messages[0].msg_kind, 'leave');
	assert.equal(json.messages[0].msg_body, 'vanisher がオフラインになりました');
});

test('落ちたままの相手を何度も流さない', async () => {
	// 状態が変わった瞬間だけを拾う。毎回流すとログが埋まる
	const gone = sweepOffline();
	assert.deepEqual(gone, []);
});

test('戻ってきてまた落ちれば、もう一度流す', async () => {
	store.setLastActiveAt('vanisher', jstBefore(0));
	sweepOffline(); // grace として覚え直す

	store.setLastActiveAt('vanisher', jstBefore(300 * 1000));
	const gone = sweepOffline();
	assert.deepEqual(gone, ['vanisher']);
});
