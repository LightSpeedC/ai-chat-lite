import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * store.mjs は読み込んだ時点で DB を開くため、その前にテスト用の DB を指定し、
 * 前回の実行結果を消しておく。何度実行しても同じ結果になるようにするため。
 * node --test はテストファイルごとに別プロセスで動くので、ここでの
 * 環境変数の変更は他のテストに影響しない。
 */
const here = dirname(fileURLToPath(import.meta.url));
const TEST_DB = join(here, '..', 'tmp', 'test-store.db');

process.env.AICHAT_DB = TEST_DB;
for (const suffix of ['', '-wal', '-shm']) rmSync(TEST_DB + suffix, { force: true });

const store = await import('../src/server/store.mjs');

// --- 準備。以降のテストはこの状態を検証する ---
store.joinUser('html2md', 'ai');
store.joinUser('test-project', 'human');

const m1 = store.addMessage({ roomId: 'public', fromUserId: 'html2md', body: '1 件目' });
const m2 = store.addMessage({ roomId: 'public', fromUserId: 'test-project', body: '2 件目' });
const m3 = store.addMessage({ roomId: 'public', fromUserId: 'html2md', toUserId: 'test-project', body: '3 件目（名指し）' });
const other = store.addMessage({ roomId: 'other', fromUserId: 'html2md', body: '別ルーム' });

test('参加登録すると users に行ができる', () => {
	assert.equal(store.listUsers().length, 2);
	assert.equal(store.getUser('html2md').user_role, 'ai');
	assert.equal(store.getUser('test-project').user_role, 'human');
});

test('接続数の初期値は 0', () => {
	assert.equal(store.getUser('html2md').active_connection_count, 0);
});

test('msg_seq は 1 から始まる連番', () => {
	assert.deepEqual([m1.msg_seq, m2.msg_seq, m3.msg_seq], [1, 2, 3]);
});

test('省略した項目に既定が入る', () => {
	assert.equal(m1.room_id, 'public');
	assert.equal(m1.msg_kind, 'say');
	assert.equal(m1.to_user_id, null, '宛先なしは NULL');
});

test('名指しの宛先が入る', () => {
	assert.equal(m3.to_user_id, 'test-project');
});

test('連番はルームを跨ぐ', () => {
	// ルームごとの連番にすると AUTOINCREMENT が使えなくなるため、通し番号にしている
	assert.equal(other.msg_seq, 4);
});

test('取得はルームで絞られる', () => {
	assert.equal(store.getSince('public', 0).length, 3);
	assert.equal(store.getSince('other', 0).length, 1);
});

test('現在位置はルームごとに求まる', () => {
	assert.equal(store.getMaxSeq('public'), 3);
	assert.equal(store.getMaxSeq('other'), 4);
	assert.equal(store.getMaxSeq('empty-room'), 0, '1 件も無ければ 0');
});

test('since より新しいものを古い順で返す', () => {
	assert.deepEqual(store.getSince('public', 1).map((r) => r.msg_seq), [2, 3]);
});

test('直近 N 件を古い順で返す（画面の初期表示）', () => {
	assert.deepEqual(store.getLatest('public', 2).map((r) => r.msg_seq), [2, 3]);
});

test('before より古いものを古い順で返す（遡り）', () => {
	assert.deepEqual(store.getBefore('public', 3, 10).map((r) => r.msg_seq), [1, 2]);
});

test('入退室も同じログに積まれる', () => {
	store.addMessage({ roomId: 'public', fromUserId: 'html2md', kind: 'join', body: 'html2md が参加しました' });
	const latest = store.getSince('public', 3);
	assert.equal(latest.length, 1);
	assert.equal(latest[0].msg_kind, 'join');
});

test('接続数は増減し、0 を下回らない', () => {
	store.addConnection('html2md');
	store.addConnection('html2md');
	assert.equal(store.getUser('html2md').active_connection_count, 2, '同じ ID の複数接続を数える');

	store.removeConnection('html2md');
	assert.equal(store.getUser('html2md').active_connection_count, 1);

	store.removeConnection('html2md');
	store.removeConnection('html2md');
	assert.equal(store.getUser('html2md').active_connection_count, 0, '余分に減らしても負にならない');
});

test('join を経ずに投稿しても users ができる', () => {
	store.touchUser('PlayWright');
	assert.equal(store.getUser('PlayWright').user_role, 'ai', '不明なときは ai として扱う');
});

test('touchUser は first_joined_at を変えない', () => {
	const before = store.getUser('html2md').first_joined_at;
	store.touchUser('html2md');
	assert.equal(store.getUser('html2md').first_joined_at, before);
});

test('sent_at は 23 文字の JST', () => {
	assert.match(m1.sent_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
});

test('msg_seq の順序と sent_at の順序が一致する', () => {
	// この一致があるため sent_at のインデックスを持たずに済んでいる
	const rows = store.getSince('public', 0);
	for (let i = 1; i < rows.length; i++) {
		assert.ok(rows[i - 1].sent_at <= rows[i].sent_at, `${rows[i - 1].sent_at} > ${rows[i].sent_at}`);
	}
});

test('不正な msg_kind を DB が弾く', () => {
	assert.throws(() => store.addMessage({ roomId: 'public', fromUserId: 'x', kind: 'shout', body: 'a' }));
});

test('空の本文を弾く', () => {
	assert.throws(() => store.addMessage({ roomId: 'public', fromUserId: 'x', body: '' }));
});

test('本文の上限は 32000 文字', () => {
	const ok = store.addMessage({ roomId: 'public', fromUserId: 'html2md', body: 'a'.repeat(32000) });
	assert.equal(ok.msg_body.length, 32000, 'ちょうどは通る');
	assert.throws(() => store.addMessage({ roomId: 'public', fromUserId: 'x', body: 'a'.repeat(32001) }));
});

test('不正な user_role を弾く', () => {
	assert.throws(() => store.joinUser('x', 'robot'));
});

test('64 文字を超える ID を弾く', () => {
	assert.throws(() => store.joinUser('a'.repeat(65), 'ai'));
	assert.throws(() => store.addMessage({ roomId: 'a'.repeat(65), fromUserId: 'x', body: 'a' }));
});

test('WAL モードで開いている', () => {
	// 読み手と書き手が同時に動けるようにするため
	assert.equal(store.getJournalMode(), 'wal');
});

test('検索がインデックスを使う', () => {
	// (room_id, msg_seq) でレンジスキャンできていること。テーブル全体を舐めていない
	const plan = store.explainSince();
	assert.match(plan, /USING INDEX messages_ix_room_id_msg_seq/, plan);
});
