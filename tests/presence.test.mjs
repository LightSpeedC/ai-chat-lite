import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const TEST_DB = join(here, '..', 'tmp', 'test-presence.db');

process.env.AICHAT_DB = TEST_DB;
for (const suffix of ['', '-wal', '-shm']) rmSync(TEST_DB + suffix, { force: true });

const store = await import('../src/server/store.mjs');
const presence = await import('../src/server/presence.mjs');
const { STATUS } = presence;
const { jstBefore, nowJst } = await import('../src/server/time.mjs');

/** 判定だけを試すための、users の行を模した値 */
function row({ connections = 0, lastActiveAt = nowJst() }) {
	return {
		user_id: 'x',
		user_role: 'ai',
		first_joined_at: lastActiveAt,
		last_active_at: lastActiveAt,
		active_connection_count: connections,
	};
}

test('接続を保持していれば online', () => {
	assert.equal(presence.getStatus(row({ connections: 1 })), STATUS.ONLINE);
});

test('接続があれば、最後のアクセスがどれだけ古くても online', () => {
	// long-poll で 4 分待ち続けている間はアクセスが無いが、繋がっている
	const old = row({ connections: 1, lastActiveAt: '2020-01-01 00:00:00.000' });
	assert.equal(presence.getStatus(old), STATUS.ONLINE);
});

test('接続が切れて猶予の内なら grace', () => {
	// 待受けを張り直す一瞬の空白を吸収するための状態
	assert.equal(presence.getStatus(row({ lastActiveAt: jstBefore(30 * 1000) })), STATUS.GRACE);
});

test('猶予を過ぎると offline', () => {
	assert.equal(presence.getStatus(row({ lastActiveAt: jstBefore(120 * 1000) })), STATUS.OFFLINE);
});

test('猶予の境界', () => {
	const threshold = presence.graceThreshold();
	assert.equal(presence.getStatus(row({ lastActiveAt: threshold }), threshold), STATUS.GRACE, '境界ちょうどは含む');

	// 1 ミリ秒古いだけで offline になる
	const justBefore = threshold.slice(0, 22) + String(Number(threshold.slice(22)) - 1);
	assert.equal(presence.getStatus(row({ lastActiveAt: justBefore }), threshold), STATUS.OFFLINE);
});

test('居ない人は offline 扱い', () => {
	assert.equal(presence.getStatus(undefined), STATUS.OFFLINE);
	assert.equal(presence.getPresence('存在しない ID'), null);
});

test('猶予の境界は DB と同じ書式で返る', () => {
	// Date のパース（ローカルタイムゾーン依存）を挟まず、文字列同士で比較するため
	assert.match(presence.graceThreshold(), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
});

test('状態は 3 つ。ラベルがすべてに用意されている', () => {
	assert.deepEqual(Object.values(STATUS), ['online', 'grace', 'offline']);
	for (const status of Object.values(STATUS)) {
		assert.ok(presence.STATUS_LABEL[status], `${status} のラベルが無い`);
	}
});

test('online と connected は status から導かれる', () => {
	const cases = [
		{ user: row({ connections: 1 }), status: STATUS.ONLINE, online: true, connected: true },
		{ user: row({ lastActiveAt: jstBefore(30 * 1000) }), status: STATUS.GRACE, online: true, connected: false },
		{ user: row({ lastActiveAt: jstBefore(120 * 1000) }), status: STATUS.OFFLINE, online: false, connected: false },
	];
	for (const c of cases) {
		const d = presence.describeUser(c.user);
		assert.equal(d.status, c.status);
		assert.equal(d.online, c.online, `${c.status} の online`);
		assert.equal(d.connected, c.connected, `${c.status} の connected`);
	}
});

test('接続中と一時切断を区別できる', () => {
	store.joinUser('connected-user', 'ai');
	store.addConnection('connected-user');
	const p = presence.getPresence('connected-user');
	assert.equal(p.status, STATUS.ONLINE);
	assert.equal(p.active_connection_count, 1);

	store.removeConnection('connected-user');
	const after = presence.getPresence('connected-user');
	assert.equal(after.status, STATUS.GRACE, '切れた直後は grace');
	assert.equal(after.online, true, 'grace もオフラインではない');
	assert.equal(after.connected, false, 'ただし接続は保持していない');
});

test('一覧は online → grace → offline の順に並ぶ', () => {
	store.joinUser('offline-user', 'ai');
	store.setLastActiveAt('offline-user', jstBefore(300 * 1000));

	store.joinUser('online-user', 'human');
	store.addConnection('online-user');

	// connected-user は前のテストで grace になっている
	const order = presence.listPresence().map((u) => u.status);
	const rank = { online: 0, grace: 1, offline: 2 };
	for (let i = 1; i < order.length; i++) {
		assert.ok(rank[order[i - 1]] <= rank[order[i]], `${order[i - 1]} の後に ${order[i]} が来ている`);
	}
});

test('同じ状態の中では最後のアクセスが新しい順', () => {
	const offlines = presence.listPresence().filter((u) => u.status === STATUS.OFFLINE);
	for (let i = 1; i < offlines.length; i++) {
		assert.ok(offlines[i - 1].last_active_at >= offlines[i].last_active_at);
	}
});

test('状態ごとに人数を数えられる', () => {
	const counts = presence.countByStatus();
	const list = presence.listPresence();
	for (const status of Object.values(STATUS)) {
		assert.equal(counts[status], list.filter((u) => u.status === status).length, `${status} の人数`);
	}
});

test('countOnline は online と grace の合計', () => {
	const counts = presence.countByStatus();
	assert.equal(presence.countOnline(), counts.online + counts.grace);
});

test('表示に必要な項目が揃っている', () => {
	const p = presence.getPresence('online-user');
	assert.deepEqual(Object.keys(p).sort(), [
		'active_connection_count',
		'connected',
		'first_joined_at',
		'last_active_at',
		'online',
		'status',
		'status_label',
		'user_id',
		'user_role',
	]);
	assert.equal(p.status_label, '接続中');
});
