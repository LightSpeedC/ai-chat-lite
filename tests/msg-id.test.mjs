import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ALPHABET, countToNn, nnToCount, makeMsgId, parseMsgId, dayOfSentAt } from '../src/server/msg-id.mjs';

describe('nn の字', () => {
	test('35 字で、l と大文字を含まない', () => {
		assert.equal(ALPHABET, '0123456789abcdefghijkmnopqrstuvwxyz');
		assert.equal(ALPHABET.length, 35);
	});
});

describe('件数 → nn', () => {
	test('計画の例どおり', () => {
		const cases = [
			[1, '01'], [10, '0a'], [20, '0k'], [21, '0m'], [34, '0z'], [35, '10'], [70, '20'],
			[1189, 'yz'], [1190, 'z000'], [1190 + 41649, 'zyzz'], [1190 + 41650, 'zz0000'],
		];
		for (const [n, nn] of cases) assert.equal(countToNn(n), nn, `${n}`);
	});

	test('0 以下・整数でない値は例外', () => {
		for (const bad of [0, -1, 1.5, NaN, '3']) assert.throws(() => countToNn(bad), RangeError);
	});

	test('1 から 200 万まで一意・順序保存・逆変換が戻る', () => {
		let prev = '';
		for (let n = 1; n <= 2_000_000; n++) {
			const nn = countToNn(n);
			assert.ok(prev < nn, `順序が崩れた: ${n - 1} → ${n} (${prev} → ${nn})`);
			if (n % 997 === 0 || n < 3000 || (n > 41000 && n < 44000) || n > 1_490_000 && n < 1_500_000) {
				assert.equal(nnToCount(nn), n, `逆変換 ${nn}`);
			}
			prev = nn;
		}
	});
});

describe('nn → 件数', () => {
	test('受けない形は null', () => {
		for (const bad of ['', '0', '000', 'l1', 'A1', '1l', 'z0', 'z00', 'zz000', '00', 'zz00', '0 ', 'z-00']) {
			assert.equal(nnToCount(bad), null, bad);
		}
	});
});

describe('msg_id', () => {
	test('日付と nn をつなぐ', () => {
		assert.equal(makeMsgId('261117', 12), 'm261117-0c');
		assert.equal(makeMsgId('261117', 1), 'm261117-01');
		assert.equal(makeMsgId('261117', 1190), 'm261117-z000');
	});

	test('parseMsgId は形に合うものだけ受ける', () => {
		assert.deepEqual(parseMsgId('m261117-0c'), { day: '261117', count: 12 });
		assert.equal(parseMsgId('2031'), null);
		assert.equal(parseMsgId('#2031'), null);
		assert.equal(parseMsgId('m261117-0l'), null);
		assert.equal(parseMsgId('M261117-0c'), null);
		assert.equal(parseMsgId('m26117-0c'), null);
		assert.equal(parseMsgId('m261117-0'), null);
		assert.equal(parseMsgId('m261117-0c '), null);
	});

	test('sent_at から日付 (yymmdd) を作る', () => {
		assert.equal(dayOfSentAt('2026/11/17 00:00:00.000'), '261117');
		assert.equal(dayOfSentAt('2026/09/07 23:59:59.999'), '260907');
	});
});
