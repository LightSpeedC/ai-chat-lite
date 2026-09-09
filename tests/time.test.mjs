import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { nowJst, jstFromParts, shiftJst } from '../src/server/time.mjs';

test('23 文字の固定長で返る', () => {
	assert.equal(nowJst().length, 23);
});

test('書式は yyyy/mm/dd hh:mm:ss.mmm', () => {
	assert.match(nowJst(), /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
});

test('UTC ではなく JST を返す', () => {
	const jstHour = Number(nowJst().slice(11, 13));
	const utcHour = new Date().getUTCHours();
	assert.equal(jstHour, (utcHour + 9) % 24);
});

test('T や Z を含まない（DB にそのまま入る形）', () => {
	const at = nowJst();
	assert.ok(!at.includes('T'), 'T が残っている');
	assert.ok(!at.includes('Z'), 'Z が残っている');
});

test('辞書順と時系列順が一致する', () => {
	// 固定長なので、文字列の大小比較がそのまま時刻の前後になる
	const older = '2026/08/29 09:00:00.000';
	const newer = '2026/08/29 10:00:00.000';
	assert.ok(older < newer);

	// 桁が揃っているため、日をまたいでも崩れない
	assert.ok('2026/08/29 23:59:59.999' < '2026/08/30 00:00:00.000');
});

describe('jstFromParts', () => {
	test('年月日時分秒から nowJst と同じ書式を組み立てる', () => {
		assert.equal(jstFromParts(2026, 8, 1, 9, 5, 3), '2026/08/01 09:05:03.000');
	});

	test('OS のタイムゾーンに関係なく、渡した値がそのまま JST として出る', () => {
		// Date.UTC に積んでいるだけなので、実行環境のローカルタイムゾーンの影響を受けない
		assert.equal(jstFromParts(2026, 1, 1, 0, 0, 0), '2026/01/01 00:00:00.000');
	});
});

describe('shiftJst', () => {
	test('1 日引くと日付が 1 つ前になる', () => {
		assert.equal(shiftJst('2026/09/09 06:00:00.000', -24 * 60 * 60 * 1000), '2026/09/08 06:00:00.000');
	});

	test('月をまたぐ引き算も正しく繰り下がる', () => {
		assert.equal(shiftJst('2026/09/01 00:00:00.000', -24 * 60 * 60 * 1000), '2026/08/31 00:00:00.000');
	});

	test('jstFromParts で組んだ文字列を shiftJst で戻しても矛盾しない', () => {
		const at = jstFromParts(2026, 3, 1, 0, 0, 0);
		assert.equal(shiftJst(at, -24 * 60 * 60 * 1000), '2026/02/28 00:00:00.000');
	});
});
