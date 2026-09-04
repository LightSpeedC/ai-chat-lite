/*
 * 古くなった参加・離脱を画面から外す判定。
 *
 * 【なぜ画面だけで絞るのか】
 * DB からは消さない。recent と dump では引き続き読める。画面は「いま何が起きて
 * いるか」を見る場なので、半日前の出入りは要らない。
 *
 * 【なぜ join と leave だけなのか】
 * archive（片付けの知らせ）には戻すボタンが付いている。消すと戻す口が無くなる。
 * 発言（say）は古くても会話そのものなので残す。
 *
 * 【なぜ文字列で比べるのか】
 * sent_at はサーバーが作った固定長の JST 文字列で、辞書順と時系列順が一致する。
 * Date のパースを挟むとブラウザのタイムゾーンに依存する。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { isStaleSystem, jstBefore, SYSTEM_KEEP_MS } from '../src/web/js/stale.js';

/** 判定の基準になる時刻。2026/09/04 21:00:00.000 JST */
const NOW = Date.UTC(2026, 8, 4, 12, 0, 0);

/** JST の文字列を作る（NOW から ms 前） */
function at(ms) {
	return jstBefore(ms, NOW);
}

const HOUR = 3600 * 1000;

describe('書式', () => {
	test('yyyy/mm/dd hh:mm:ss.mmm の 23 文字で返る', () => {
		const s = at(0);
		assert.equal(s.length, 23);
		assert.match(s, /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
	});

	test('JST に直っている', () => {
		// UTC 12:00 は JST 21:00
		assert.equal(at(0), '2026/09/04 21:00:00.000');
	});

	test('保つ長さは 12 時間', () => {
		assert.equal(SYSTEM_KEEP_MS, 12 * HOUR);
	});
});

describe('参加・離脱', () => {
	test('12 時間より前の join は出さない', () => {
		assert.equal(isStaleSystem({ msg_kind: 'join', sent_at: at(13 * HOUR) }, NOW), true);
	});

	test('12 時間より前の leave は出さない', () => {
		assert.equal(isStaleSystem({ msg_kind: 'leave', sent_at: at(13 * HOUR) }, NOW), true);
	});

	test('12 時間以内なら出す', () => {
		assert.equal(isStaleSystem({ msg_kind: 'join', sent_at: at(11 * HOUR) }, NOW), false);
	});

	test('ちょうど 12 時間は出す', () => {
		// 境目で消えるかどうかは、どちらでも困らない。動きを固定しておく
		assert.equal(isStaleSystem({ msg_kind: 'join', sent_at: at(SYSTEM_KEEP_MS) }, NOW), false);
	});

	test('たったいまの join は出す', () => {
		assert.equal(isStaleSystem({ msg_kind: 'join', sent_at: at(0) }, NOW), false);
	});
});

describe('ほかの種別は消さない', () => {
	test('古い say も出す', () => {
		// 会話そのものなので、いつまでも残す
		assert.equal(isStaleSystem({ msg_kind: 'say', sent_at: at(100 * HOUR) }, NOW), false);
	});

	test('古い archive も出す', () => {
		// 戻すボタンが付いている。消すと戻す口が無くなる
		assert.equal(isStaleSystem({ msg_kind: 'archive', sent_at: at(100 * HOUR) }, NOW), false);
	});

	test('古い notice も出す', () => {
		assert.equal(isStaleSystem({ msg_kind: 'notice', sent_at: at(100 * HOUR) }, NOW), false);
	});
});

describe('旧書式が混ざったとき', () => {
	test('- 区切りの古い行は消える側になる', () => {
		/*
		 * 版 5 で全行を / に書き換えたので、本番には残っていない。
		 * 控えから戻したときのために動きを書き留めておく。
		 * '-'（0x2D）は '/'（0x2F）より小さいため、常に「古い」と判定される。
		 */
		assert.equal(isStaleSystem({ msg_kind: 'join', sent_at: '2026-09-04 20:59:59.999' }, NOW), true);
	});
});
