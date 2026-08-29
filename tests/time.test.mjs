import { test } from 'node:test';
import assert from 'node:assert/strict';

import { nowJst } from '../src/server/time.mjs';

test('23 文字の固定長で返る', () => {
	assert.equal(nowJst().length, 23);
});

test('書式は yyyy-mm-dd hh:mm:ss.mmm', () => {
	assert.match(nowJst(), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
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
	const older = '2026-08-29 09:00:00.000';
	const newer = '2026-08-29 10:00:00.000';
	assert.ok(older < newer);

	// 桁が揃っているため、日をまたいでも崩れない
	assert.ok('2026-08-29 23:59:59.999' < '2026-08-30 00:00:00.000');
});
