import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { isUnderMaintenance, readReason, waitUntilCleared } from '../src/server/maintenance.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const TMP = join(here, '..', 'tmp');
const MARK = join(TMP, 'test-MAINTENANCE');

mkdirSync(TMP, { recursive: true });

function put(body = '') {
	writeFileSync(MARK, body, 'utf8');
}

function clear() {
	rmSync(MARK, { force: true });
}

test('印が無ければ待たない', async () => {
	clear();
	assert.equal(isUnderMaintenance(MARK), false);

	const started = Date.now();
	const waited = await waitUntilCleared({ file: MARK, pollMs: 50 });
	assert.equal(waited, false, '待ったことになっている');
	assert.ok(Date.now() - started < 500, '即座に返るはず');
});

test('印があれば待ち、消えたら進む', async () => {
	put();
	assert.equal(isUnderMaintenance(MARK), true);

	const started = Date.now();
	const waiting = waitUntilCleared({ file: MARK, pollMs: 50 });

	// 待ち続けていることを確かめてから消す
	await new Promise((r) => setTimeout(r, 200));
	let finished = false;
	waiting.then(() => { finished = true; });
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(finished, false, '印があるうちに進んでいる');

	clear();
	const waited = await waiting;

	assert.equal(waited, true);
	assert.ok(Date.now() - started >= 200, '消すまでは待つ');
	assert.ok(Date.now() - started < 5000, '消したら速やかに進む');
});

test('理由を読める', () => {
	put('スキーマを入れ替えている');
	assert.equal(readReason(MARK), 'スキーマを入れ替えている');
	clear();
});

test('中身が空でも扱える', () => {
	put('');
	assert.equal(isUnderMaintenance(MARK), true);
	assert.equal(readReason(MARK), '');
	clear();
});

test('印が無いときに理由を読んでも落ちない', () => {
	clear();
	assert.equal(readReason(MARK), '');
});

test('ポーリングだけでも拾える', async () => {
	// fs.watch が働かない環境でも、間隔ごとの確認で気づけること
	put();
	const waiting = waitUntilCleared({ file: MARK, pollMs: 60 });
	await new Promise((r) => setTimeout(r, 100));
	clear();
	assert.equal(await waiting, true);
});
