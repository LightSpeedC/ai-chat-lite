/*
 * 参加者の ID を付け替える (rename)。
 *
 * 【なぜ要るのか】
 * プロジェクト名を変えると、名乗る ID も変えたくなる。ID は connectors だけで
 * なく cursors ・ messages (発言者と宛先)・ archives にも散っており、
 * 1 つでも漏らすと「発言は見えるのに参加者一覧にいない」「読んだ位置を失って
 * 過去を読み直す」といった形で表に出る。手で SQL を書いていたときは、
 * 対象を洗い出すところから毎回やり直していた (i260909-02)。
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

describe('下見 (previewRename)', () => {
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

	test('居ない ID は 0 件で返る (例外にしない)', () => {
		const counts = store.previewRename('test-rename-nobody');

		assert.equal(counts.connectors, 0);
		assert.equal(counts.cursors, 0);
		assert.equal(counts.messages_from, 0);
		assert.equal(counts.messages_to, 0);
	});
});

describe('付け替える (renameConnector)', () => {
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
	 * (「@project-a ご報告ありがとうございます」など)。列だけ直して本文を
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
	 * 壊れる。共通ルールも「前方一致では探さない」と明記している (実際に
	 * 待受けの検索式で事故になった)。ID に使える文字が続くときは置き換えない。
	 */
	test('前方一致では置き換えない (@旧ID の続きが ID の文字なら別物)', () => {
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
		// 断ったあとも元のままであること (途中まで書き換わっていない)
		assert.ok(store.getConnector('test-rename-e'), '断ったのに元が消えている');
	});

	/*
	 * 【なぜ必要か】
	 * 片付けた参加者は connectors に行が残り、主キーの枠を占め続ける
	 * (archived_seq が入るだけ)。読み出しには出ないので「空いている」ように
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

/*
 * 既にある ID へまとめる (merge)。i261110-02。
 *
 * 【なぜ要るのか】
 * プロジェクトの置き場を移すと、新しい置き場のセッションが先に新しい ID で
 * 発言してしまう。そのあとで古い ID の記録を寄せようとすると、新しい ID が
 * 「既に使われている」ので、ふつうの rename は断る (上の試験のとおり)。
 * merge を明示したときだけ、両方の記録を新しい ID の 1 つにまとめる。
 */
describe('既にある ID へまとめる (merge)', () => {
	test('merge を付けると、旧 ID の発言 ・ 宛先 ・ 本文が新しい ID に寄り、旧 ID の参加者は消える', () => {
		store.joinConnector('test-merge-old', 'ai');
		store.joinConnector('test-merge-new', 'ai');
		say('sandbox-merge', 'test-merge-old', '旧 ID の発言');
		say('sandbox-merge', 'test-merge-new', '新しい ID の発言');
		say('sandbox-merge', 'test-rename-watcher', '@test-merge-old へ', 'test-merge-old');

		const result = store.renameConnector('test-merge-old', 'test-merge-new', { merge: true });

		assert.ok(result, '結果が返っていない');
		assert.equal(result.messages_from, 1);
		assert.equal(result.messages_to, 1);
		assert.equal(result.messages_body, 1);

		assert.equal(store.getConnector('test-merge-old'), undefined, '旧 ID の参加者が残っている');
		assert.ok(store.getConnector('test-merge-new'), '新しい ID の参加者が消えている');

		const messages = store.getLatest('sandbox-merge', 50);
		assert.equal(messages.filter((m) => m.from_connector_id === 'test-merge-new').length, 2, '発言が 1 つにまとまっていない');
		assert.ok(!messages.some((m) => m.from_connector_id === 'test-merge-old'), '旧 ID の発言者が残っている');
		assert.ok(messages.some((m) => m.to_connector_id === 'test-merge-new'), '宛先が寄っていない');
		assert.ok(messages.some((m) => m.msg_body.includes('@test-merge-new')), '本文の @旧ID が寄っていない');
	});

	/*
	 * 参加した時刻は古いほう、最後に動いた時刻は新しいほうを残す。
	 * どちらか片方の行をそのまま残すと、参加の古さか、最後の動きのどちらかを失う。
	 */
	test('参加した時刻は古いほう、最後に動いた時刻は新しいほうを残す', () => {
		store.joinConnector('test-merge-t-old', 'ai');
		store.joinConnector('test-merge-t-new', 'ai');
		// 旧 ID のほうが最後に動いた形にする (移した直後に旧 ID がまだ動いていた場合)
		store.setLastActiveAt('test-merge-t-new', '2026/11/10 10:00:00.000');
		store.setLastActiveAt('test-merge-t-old', '2026/11/10 11:00:00.000');
		const oldRow = store.getConnector('test-merge-t-old');
		const newRow = store.getConnector('test-merge-t-new');
		const firstJoined = [oldRow.first_joined_at, newRow.first_joined_at].sort()[0];

		store.renameConnector('test-merge-t-old', 'test-merge-t-new', { merge: true });

		const merged = store.getConnector('test-merge-t-new');
		assert.equal(merged.first_joined_at, firstJoined, '参加した時刻が古いほうになっていない');
		assert.equal(merged.last_active_at, '2026/11/10 11:00:00.000', '最後に動いた時刻が新しいほうになっていない');
	});

	/*
	 * 読んだ位置は進んでいるほうを残す (24-A)。遅れているほうを残すと、
	 * もう一方の ID で読んだ発言がまとめて届き直す。
	 */
	test('同じルームの読んだ位置は、旧 ID が進んでいれば旧 ID の位置を残す', () => {
		store.joinConnector('test-merge-c-old', 'ai');
		store.joinConnector('test-merge-c-new', 'ai');
		const m1 = say('sandbox-merge-c', 'test-rename-watcher', '1 件目');
		const m2 = say('sandbox-merge-c', 'test-rename-watcher', '2 件目');
		store.setCursor('test-merge-c-new', 'sandbox-merge-c', m1.msg_seq);
		store.setCursor('test-merge-c-old', 'sandbox-merge-c', m2.msg_seq);

		store.renameConnector('test-merge-c-old', 'test-merge-c-new', { merge: true });

		assert.equal(store.getCursor('test-merge-c-new', 'sandbox-merge-c'), m2.msg_seq, '進んでいる位置を失った');
		assert.equal(store.getAckedSeq('test-merge-c-new', 'sandbox-merge-c'), m2.msg_seq, '確定済み位置を失った');
		assert.equal(store.getCursor('test-merge-c-old', 'sandbox-merge-c'), null, '旧 ID の位置が残っている');
	});

	test('同じルームの読んだ位置は、新しい ID が進んでいれば新しい ID の位置を残す', () => {
		store.joinConnector('test-merge-d-old', 'ai');
		store.joinConnector('test-merge-d-new', 'ai');
		const m1 = say('sandbox-merge-d', 'test-rename-watcher', '1 件目');
		const m2 = say('sandbox-merge-d', 'test-rename-watcher', '2 件目');
		store.setCursor('test-merge-d-old', 'sandbox-merge-d', m1.msg_seq);
		store.setCursor('test-merge-d-new', 'sandbox-merge-d', m2.msg_seq);

		store.renameConnector('test-merge-d-old', 'test-merge-d-new', { merge: true });

		assert.equal(store.getCursor('test-merge-d-new', 'sandbox-merge-d'), m2.msg_seq, '後退した');
		assert.equal(store.getAckedSeq('test-merge-d-new', 'sandbox-merge-d'), m2.msg_seq, '確定済み位置が後退した');
	});

	test('旧 ID にしか読んだ位置が無いルームは、そのまま新しい ID へ移る', () => {
		store.joinConnector('test-merge-e-old', 'ai');
		store.joinConnector('test-merge-e-new', 'ai');
		const m = say('sandbox-merge-e', 'test-rename-watcher', '旧 ID だけが読んだ');
		store.setCursor('test-merge-e-old', 'sandbox-merge-e', m.msg_seq);

		store.renameConnector('test-merge-e-old', 'test-merge-e-new', { merge: true });

		assert.equal(store.getCursor('test-merge-e-new', 'sandbox-merge-e'), m.msg_seq, '位置が移っていない');
	});

	test('まとめ先が無ければ、merge を付けてもふつうに付け替える', () => {
		store.joinConnector('test-merge-f-old', 'ai');
		say('sandbox-merge-f', 'test-merge-f-old', '付け替える');

		const result = store.renameConnector('test-merge-f-old', 'test-merge-f-new', { merge: true });

		assert.equal(result.connectors, 1);
		assert.ok(store.getConnector('test-merge-f-new'), '新しい ID で見えない');
		assert.equal(store.getConnector('test-merge-f-old'), undefined, '古い ID が残っている');
	});

	/*
	 * 片付けた参加者へまとめると、片付けた記録 (archived_seq)の中へ生きた発言を
	 * 混ぜることになり、restore したときの戻り方が読めなくなる。断る。
	 */
	test('まとめ先が片付け済みなら、merge を付けても断る', () => {
		store.joinConnector('test-merge-g-old', 'ai');
		store.joinConnector('test-merge-g-archived', 'ai');
		say('public', 'test-merge-g-archived', '片付けられる');
		store.archive({
			kind: 'connector',
			id: 'test-merge-g-archived',
			byConnectorId: 'test-rename-watcher',
			description: 'まとめ先にしない',
		});

		assert.throws(
			() => store.renameConnector('test-merge-g-old', 'test-merge-g-archived', { merge: true }),
			/片付け/
		);
		assert.ok(store.getConnector('test-merge-g-old'), '断ったのに元が消えている');
	});
});
