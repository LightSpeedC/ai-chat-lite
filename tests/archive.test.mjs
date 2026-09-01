import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { prepareTestDb } from './helpers/prepare-db.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const TEST_DATA = join(here, '..', 'tmp', '_data', 'unit-archive');

// 版を当ててから store を読み込む（store.mjs は形を作らない）
await prepareTestDb(TEST_DATA);

const store = await import('../src/server/store.mjs');

/**
 * 片付けたものが読み出しに出ないことを確かめる。
 *
 * ここが最も危ない。読み出しの関数はいくつもあり、1 つ足し忘れると
 * 「片付けたはずのものが出る」ことになる。
 */

/** その場かぎりの発言を積む */
function say(roomId, from, body) {
	return store.addMessage({ roomId, fromConnectorId: from, body });
}

describe('片付ける前の下見', () => {
	test('ルームの件数を数える', () => {
		say('sandbox-preview', 'test-connector1', '1 件目');
		say('sandbox-preview', 'test-connector1', '2 件目');
		store.setCursor('test-connector1', 'sandbox-preview', 1);

		const counts = store.previewArchive('room', 'sandbox-preview');

		assert.equal(counts.messages, 2);
		assert.equal(counts.cursors, 1);
		assert.equal(counts.connectors, 0);
		assert.ok(counts.first, 'いつからかが入っていない');
		assert.ok(counts.last, 'いつまでかが入っていない');
	});

	test('参加者は既定で発言を含めない', () => {
		store.joinConnector('test-preview-c', 'ai');
		say('sandbox-preview2', 'test-preview-c', 'この発言は残る');
		store.setCursor('test-preview-c', 'sandbox-preview2', 1);

		const without = store.previewArchive('connector', 'test-preview-c', false);
		assert.equal(without.connectors, 1);
		assert.equal(without.cursors, 1);
		assert.equal(without.messages, 0, '既定では発言を含めない');

		const with_ = store.previewArchive('connector', 'test-preview-c', true);
		assert.equal(with_.messages, 1, '--with-messages では含める');
	});

	test('無いものは 0 件になる', () => {
		const counts = store.previewArchive('room', 'sandbox-存在しない');
		assert.equal(counts.messages + counts.cursors + counts.connectors, 0);
	});
});

describe('ルームを片付ける', () => {
	let seq;
	let m1;
	let m2;

	before(() => {
		m1 = say('sandbox-gone', 'test-connector1', '消える 1');
		m2 = say('sandbox-gone', 'test-connector1', '消える 2');
		say('public', 'test-connector1', '残る');
		store.setCursor('test-connector1', 'sandbox-gone', m1.msg_seq);

		const result = store.archive({
			kind: 'room',
			id: 'sandbox-gone',
			byConnectorId: 'test-connector1',
			description: 'ルームを片付けた',
		});
		seq = result.archived_seq;
	});

	test('archives に 1 行残る', () => {
		const list = store.listArchives();
		const row = list.find((a) => a.archived_seq === seq);

		assert.ok(row, 'archives に無い');
		assert.equal(row.description, 'ルームを片付けた');
		assert.equal(row.archived_connector_id, 'test-connector1');
		assert.equal(Number(row.msg_count), 2);
		assert.equal(Number(row.cursor_count), 1);
	});

	test('対象が説明とは別の列に残る', () => {
		/*
		 * description は --description で書き換えられる。書き換えても
		 * 「何を片付けたか」を追えるよう、kind と id を列で持っている。
		 */
		const row = store.listArchives().find((a) => a.archived_seq === seq);

		assert.equal(row.archive_kind, 'room');
		assert.equal(row.archive_id, 'sandbox-gone');
	});

	test('getSince に出ない', () => {
		assert.deepEqual(store.getSince('sandbox-gone', 0), []);
	});

	test('getLatest に出ない', () => {
		assert.deepEqual(store.getLatest('sandbox-gone', 50), []);
	});

	test('getBefore に出ない', () => {
		assert.deepEqual(store.getBefore('sandbox-gone', 9999, 50), []);
	});

	test('getMaxSeq が 0 になる', () => {
		// 読み始めの位置。ここに残っていると、片付けた分から待ち始めてしまう
		assert.equal(store.getMaxSeq('sandbox-gone'), 0);
	});

	test('listRooms に出ない', () => {
		const rooms = store.listRooms().map((r) => r.room_id);
		assert.ok(!rooms.includes('sandbox-gone'), `ルームの一覧に残っている: ${rooms.join(' ')}`);
	});

	test('getCursor が null になる', () => {
		assert.equal(store.getCursor('test-connector1', 'sandbox-gone'), null);
	});

	test('listCursors に出ない', () => {
		const rooms = store.listCursors('test-connector1').map((c) => c.room_id);
		assert.ok(!rooms.includes('sandbox-gone'));
	});

	test('別のルームには影響しない', () => {
		assert.equal(store.getSince('public', 0).length > 0, true, 'public の発言まで消えている');
	});

	test('dump には出る', () => {
		/*
		 * getAllMessages だけは絞らない。dump は中身を確かめるためのもので、
		 * 片付けたものも見えた方がよい。archived_seq も一緒に書き出す。
		 */
		const all = store.getAllMessages();
		const gone = all.filter((m) => m.room_id === 'sandbox-gone');

		assert.equal(gone.length, 2, 'dump から消えている');
		assert.equal(gone[0].archived_seq, seq, 'archived_seq が入っていない');
	});
});

describe('参加者を片付ける', () => {
	test('既定では発言を残す', () => {
		store.joinConnector('test-keep-msg', 'ai');
		const m = say('public', 'test-keep-msg', 'この発言は残る');
		store.setCursor('test-keep-msg', 'public', m.msg_seq);

		store.archive({ kind: 'connector', id: 'test-keep-msg', byConnectorId: 'test-connector1', description: '参加者だけ' });

		assert.equal(store.getConnector('test-keep-msg'), undefined, '参加者が残っている');
		assert.equal(store.getCursor('test-keep-msg', 'public'), null, '読んだ位置が残っている');
		assert.ok(
			store.getSince('public', 0).some((x) => x.msg_seq === m.msg_seq),
			'発言まで消えている'
		);
	});

	test('--with-messages では発言も片付ける', () => {
		store.joinConnector('test-drop-msg', 'ai');
		const m = say('public', 'test-drop-msg', 'この発言も消える');

		store.archive({
			kind: 'connector',
			id: 'test-drop-msg',
			withMessages: true,
			byConnectorId: 'test-connector1',
			description: '発言も含めて',
		});

		assert.ok(
			!store.getSince('public', 0).some((x) => x.msg_seq === m.msg_seq),
			'発言が残っている'
		);
	});

	test('listConnectors に出ない', () => {
		const ids = store.listConnectors().map((c) => c.connector_id);
		assert.ok(!ids.includes('test-keep-msg'));
		assert.ok(!ids.includes('test-drop-msg'));
	});
});

describe('発言 1 件を片付ける', () => {
	test('その 1 件だけが消える', () => {
		const a = say('sandbox-one', 'test-connector1', '消す');
		const b = say('sandbox-one', 'test-connector1', '残す');

		const { archived_seq } = store.archive({
			kind: 'message',
			id: a.msg_seq,
			byConnectorId: 'test-connector1',
			description: '貼り間違い',
		});

		const seqs = store.getSince('sandbox-one', 0).map((m) => m.msg_seq);
		assert.ok(!seqs.includes(a.msg_seq), '消えていない');
		assert.ok(seqs.includes(b.msg_seq), '関係ない発言まで消えている');

		// 数値の id も文字列の列に入る。3 種の対象を 1 列で持つため
		const row = store.listArchives().find((x) => x.archived_seq === archived_seq);
		assert.equal(row.archive_kind, 'message');
		assert.equal(row.archive_id, String(a.msg_seq));
	});
});

describe('戻す', () => {
	test('同じ番号のものがまとめて戻る', () => {
		const m1 = say('sandbox-back', 'test-connector1', '戻る 1');
		const m2 = say('sandbox-back', 'test-connector1', '戻る 2');
		store.setCursor('test-connector1', 'sandbox-back', m1.msg_seq);

		const { archived_seq } = store.archive({
			kind: 'room',
			id: 'sandbox-back',
			byConnectorId: 'test-connector1',
			description: '戻す試し',
		});
		assert.deepEqual(store.getSince('sandbox-back', 0), [], '片付いていない');

		const result = store.restore(archived_seq);

		assert.equal(result.restored, 3, '発言 2 件と読んだ位置 1 件が戻るはず');
		assert.equal(store.getSince('sandbox-back', 0).length, 2);
		assert.equal(store.getCursor('test-connector1', 'sandbox-back'), m1.msg_seq);
	});

	test('戻すと archives の行も消える', () => {
		// 番号が残っていると「戻したのにまだある」ことになる
		const m = say('sandbox-back2', 'test-connector1', 'x');
		const { archived_seq } = store.archive({
			kind: 'room',
			id: 'sandbox-back2',
			byConnectorId: 'test-connector1',
			description: '消える記録',
		});

		store.restore(archived_seq);

		assert.ok(!store.listArchives().some((a) => a.archived_seq === archived_seq));
	});

	test('無い番号は null で返る', () => {
		assert.equal(store.restore(99999), null);
	});
});

describe('読み出しの絞り込みを足し忘れていないか', () => {
	test('messages を読む関数はすべて絞り込みを持つ（dump だけ例外）', () => {
		/*
		 * 関数を増やしたときに気づけるようにする。
		 *
		 * store.mjs の SQL を読み、messages / cursors / connectors から SELECT する
		 * 文が archived_seq IS NULL を持っているかを見る。
		 */
		const src = readFileSync(join(here, '..', 'src', 'server', 'store.mjs'), 'utf8');
		const block = src.slice(src.indexOf('const stmt = {'), src.indexOf('/** 取得件数を'));

		// 名前: SQL の組を取り出す
		const entries = [...block.matchAll(/(\w+):\s*db\.prepare\(\s*(`[\s\S]*?`|'[^']*')\s*\)/g)].map((m) => ({
			name: m[1],
			sql: m[2],
		}));

		assert.ok(entries.length >= 15, `SQL を拾えていない（${entries.length} 件）`);

		const reads = entries.filter((e) => /SELECT/i.test(e.sql));
		const missing = reads
			.filter((e) => e.name !== 'selectAll') // dump は絞らない
			.filter((e) => !/archived_seq IS NULL/.test(e.sql))
			.map((e) => e.name);

		assert.deepEqual(missing, [], `絞り込みが無い読み出し: ${missing.join(' ')}`);
	});

	test('dump の SQL には絞り込みを入れない', () => {
		const src = readFileSync(join(here, '..', 'src', 'server', 'store.mjs'), 'utf8');
		const m = src.match(/selectAll:\s*db\.prepare\('([^']*)'\)/);

		assert.ok(m, 'selectAll が見つからない');
		assert.doesNotMatch(m[1], /archived_seq IS NULL/, 'dump は片付けたものも見せる');
	});
});
