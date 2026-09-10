/*
 * 参加者の ID を付け替える（rename）。
 *
 * 【なぜ要るのか】
 * プロジェクト名を変えると、名乗る ID も変えたくなる。ID は connectors だけで
 * なく cursors ・ messages（発言者と宛先）・ archives にも散っており、
 * 1 つでも漏らすと「発言は見えるのに参加者一覧にいない」「読んだ位置を失って
 * 過去を読み直す」といった形で表に出る。手で SQL を書いていたときは、
 * 対象を洗い出すところから毎回やり直していた（i260909-02）。
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { prepareTestDb } from './helpers/prepare-db.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const TEST_DATA = join(here, '..', 'tmp', '_data', 'unit-rename');

await prepareTestDb(TEST_DATA);

const store = await import('../src/server/store.mjs');

/** その場かぎりの発言を積む */
function say(roomId, from, body, to = null) {
	return store.addMessage({ roomId, fromConnectorId: from, body, toConnectorId: to });
}

describe('下見（previewRename）', () => {
	before(() => {
		store.joinConnector('test-rename-a', 'ai');
		store.joinConnector('test-rename-watcher', 'ai');
		const m = say('public', 'test-rename-a', '改名前の発言');
		say('public', 'test-rename-watcher', '名指しする', 'test-rename-a');
		store.setCursor('test-rename-a', 'public', m.msg_seq);
	});

	test('4 つのテーブルをまたいで数える', () => {
		const counts = store.previewRename('test-rename-a');

		assert.equal(counts.connectors, 1, 'connectors が数えられていない');
		assert.equal(counts.cursors, 1, 'cursors が数えられていない');
		assert.equal(counts.messages_from, 1, '発言者としての件数が違う');
		assert.equal(counts.messages_to, 1, '宛先としての件数が違う');
	});

	test('居ない ID は 0 件で返る（例外にしない）', () => {
		const counts = store.previewRename('test-rename-nobody');

		assert.equal(counts.connectors, 0);
		assert.equal(counts.cursors, 0);
		assert.equal(counts.messages_from, 0);
		assert.equal(counts.messages_to, 0);
	});
});

describe('付け替える（renameConnector）', () => {
	before(() => {
		store.joinConnector('test-rename-b', 'ai');
		const m = say('sandbox-rename', 'test-rename-b', '付け替える前');
		say('sandbox-rename', 'test-rename-watcher', '名指し', 'test-rename-b');
		store.setCursor('test-rename-b', 'sandbox-rename', m.msg_seq);
	});

	test('4 つのテーブルすべてで新しい ID になる', () => {
		const before = store.getCursor('test-rename-b', 'sandbox-rename');
		assert.ok(before > 0, '前提: 読んだ位置がある');

		const result = store.renameConnector('test-rename-b', 'test-renamed-b');

		assert.ok(result, '結果が返っていない');
		assert.equal(result.connectors, 1);
		assert.equal(result.cursors, 1);
		assert.equal(result.messages_from, 1);
		assert.equal(result.messages_to, 1);

		// 参加者一覧は新しい ID で見える。古い ID は消える
		assert.ok(store.getConnector('test-renamed-b'), '新しい ID で見えない');
		assert.equal(store.getConnector('test-rename-b'), undefined, '古い ID が残っている');

		// 読んだ位置は引き継がれる。失うと過去を読み直す
		assert.equal(store.getCursor('test-renamed-b', 'sandbox-rename'), before, '読んだ位置が引き継がれていない');
		assert.equal(store.getCursor('test-rename-b', 'sandbox-rename'), null, '古い ID に位置が残っている');

		// 発言も宛先も付け替わる
		const messages = store.getLatest('sandbox-rename', 50);
		assert.ok(messages.some((m) => m.from_connector_id === 'test-renamed-b'), '発言者が変わっていない');
		assert.ok(messages.some((m) => m.to_connector_id === 'test-renamed-b'), '宛先が変わっていない');
		assert.ok(!messages.some((m) => m.from_connector_id === 'test-rename-b'), '古い発言者が残っている');
	});

	test('居ない ID は null で返る', () => {
		assert.equal(store.renameConnector('test-rename-nobody', 'test-rename-x'), null);
	});
});

describe('本文の中の @旧ID も付け替える', () => {
	/*
	 * 【なぜ必要か】
	 * 名指しは to_connector_id に入るが、本文に自分で @相手 と書く形も普通に使う
	 * （「@project-a ご報告ありがとうございます」など）。列だけ直して本文を
	 * 置き去りにすると、過去のやり取りだけ古い名前で残り、検索も当たらなくなる。
	 */
	test('本文の @旧ID が新しい ID になる', () => {
		store.joinConnector('test-rename-body', 'ai');
		say('sandbox-rename-body', 'test-rename-watcher', '@test-rename-body お願いします');
		say('sandbox-rename-body', 'test-rename-watcher', '文中でも @test-rename-body と書く');

		const result = store.renameConnector('test-rename-body', 'test-renamed-body');

		assert.equal(result.messages_body, 2, '本文の置き換えが数えられていない');
		const bodies = store.getLatest('sandbox-rename-body', 50).map((m) => m.msg_body);
		assert.ok(bodies.every((b) => !b.includes('@test-rename-body')), '古い名前が本文に残っている');
		assert.ok(bodies.some((b) => b.includes('@test-renamed-body')), '新しい名前になっていない');
	});

	/*
	 * 【なぜ必要か】
	 * 前方一致で置き換えると、@project-a を直したつもりで @project-aa まで
	 * 壊れる。共通ルールも「前方一致では探さない」と明記している（実際に
	 * 待受けの検索式で事故になった）。ID に使える文字が続くときは置き換えない。
	 */
	test('前方一致では置き換えない（@旧ID の続きが ID の文字なら別物）', () => {
		store.joinConnector('test-rename-p', 'ai');
		store.joinConnector('test-rename-pp', 'ai');
		say('sandbox-rename-p', 'test-rename-watcher', '@test-rename-pp は別の相手');
		say('sandbox-rename-p', 'test-rename-watcher', '@test-rename-p が本人');

		const result = store.renameConnector('test-rename-p', 'test-renamed-p');

		assert.equal(result.messages_body, 1, '巻き込んで置き換えている');
		const bodies = store.getLatest('sandbox-rename-p', 50).map((m) => m.msg_body);
		assert.ok(bodies.some((b) => b.includes('@test-rename-pp')), '別の相手まで書き換わっている');
		assert.ok(bodies.some((b) => b.includes('@test-renamed-p ')), '本人が置き換わっていない');
	});
});

describe('archives も付け替える', () => {
	test('片付けた記録の中の ID も変わる', () => {
		store.joinConnector('test-rename-c', 'ai');
		say('sandbox-rename-c', 'test-rename-c', '片付けられる発言');

		// この参加者自身が片付けを実行した記録を作る
		const archived = store.archive({
			kind: 'room',
			id: 'sandbox-rename-c',
			byConnectorId: 'test-rename-c',
			description: '改名の検査',
		});
		assert.ok(archived.archived_seq > 0);

		const result = store.renameConnector('test-rename-c', 'test-renamed-c');

		assert.equal(result.archives, 1, 'archives の実行者が付け替わっていない');
		const row = store.listArchives().find((a) => a.archived_seq === archived.archived_seq);
		assert.equal(row.archived_connector_id, 'test-renamed-c');
	});

	test('参加者を片付けた記録は、対象の ID も変わる', () => {
		store.joinConnector('test-rename-d', 'ai');
		say('public', 'test-rename-d', '片付けられる参加者の発言');
		const archived = store.archive({
			kind: 'connector',
			id: 'test-rename-d',
			byConnectorId: 'test-rename-watcher',
			description: '対象としての改名の検査',
		});

		const result = store.renameConnector('test-rename-d', 'test-renamed-d');

		/*
		 * archive_kind が connector のときだけ、archive_id も参加者の ID である。
		 * ここを漏らすと、archives の一覧に古い名前が残り、戻す判断ができなくなる。
		 */
		assert.equal(result.archive_targets, 1, 'archives の対象が付け替わっていない');
		const row = store.listArchives().find((a) => a.archived_seq === archived.archived_seq);
		assert.equal(row.archive_id, 'test-renamed-d');
	});
});

describe('断る条件', () => {
	test('新しい ID が既に使われていたら断る', () => {
		store.joinConnector('test-rename-e', 'ai');
		store.joinConnector('test-rename-taken', 'ai');

		assert.throws(
			() => store.renameConnector('test-rename-e', 'test-rename-taken'),
			/既に使われています|already/
		);
		// 断ったあとも元のままであること（途中まで書き換わっていない）
		assert.ok(store.getConnector('test-rename-e'), '断ったのに元が消えている');
	});

	/*
	 * 【なぜ必要か】
	 * 片付けた参加者は connectors に行が残り、主キーの枠を占め続ける
	 * （archived_seq が入るだけ）。読み出しには出ないので「空いている」ように
	 * 見えるが、その名前へ付け替えると主キーが衝突する。
	 */
	test('片付け済みの ID も「使われている」として断る', () => {
		store.joinConnector('test-rename-f', 'ai');
		store.joinConnector('test-rename-archived', 'ai');
		say('public', 'test-rename-archived', '片付けられる');
		store.archive({
			kind: 'connector',
			id: 'test-rename-archived',
			byConnectorId: 'test-rename-watcher',
			description: '枠を占めたままにする',
		});
		assert.equal(store.getConnector('test-rename-archived'), undefined, '前提: 読み出しには出ない');

		assert.throws(
			() => store.renameConnector('test-rename-f', 'test-rename-archived'),
			/既に使われています|already/
		);
	});

	test('同じ ID への付け替えは断る', () => {
		store.joinConnector('test-rename-g', 'ai');

		assert.throws(() => store.renameConnector('test-rename-g', 'test-rename-g'), /同じ/);
	});
});
