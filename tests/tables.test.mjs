/*
 * REQUIRED_TABLES と、版が実際に作るテーブルが一致していることを確かめる。
 *
 * 【なぜ一覧を別のモジュールに置いているのか】
 * store.mjs は最上位で DB を開き、揃っていなければ throw する。import した時点で
 * 落ちるため、store.mjs から一覧を読むテストは本体が走らない。tables.mjs は
 * DB を開かないので、ここから読める。
 *
 * 【何が怖いのか】
 * 打ち間違いより、版でテーブルを足したのに一覧へ入れ忘れるほうが起きやすい。
 * 入れ忘れても検査は通るので、空の DB から起動したときだけ形が違う状態になり、
 * 気づくのが最後になる。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { prepareTestDb } from './helpers/prepare-db.mjs';
import { REQUIRED_TABLES } from '../src/server/tables.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const TEST_DATA = join(here, '..', 'tmp', '_data', 'unit-tables');

await prepareTestDb(TEST_DATA);

// 開いたら閉じる。読み取りだけでも -wal と -shm は残るが、置き場は tmp/ である
const db = new DatabaseSync(join(TEST_DATA, 'chat.db'));
const actual = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
db.close();

test('REQUIRED_TABLES のテーブルはすべて版が作る', () => {
	for (const name of REQUIRED_TABLES) {
		assert.ok(actual.has(name), `版が作らないテーブルが REQUIRED_TABLES にある: ${name}`);
	}
});

test('版が作るテーブルは REQUIRED_TABLES か versions のどちらかである', () => {
	// sqlite_sequence は AUTOINCREMENT が作る SQLite 側のテーブル
	const known = new Set([...REQUIRED_TABLES, 'versions', 'sqlite_sequence']);
	for (const name of actual) {
		assert.ok(known.has(name), `REQUIRED_TABLES に入っていないテーブルがある: ${name}`);
	}
});

test('versions は REQUIRED_TABLES に入れない', () => {
	// migrate.mjs 自身が作るため、store.mjs が開く時点で必ず在る。確かめても発火しない
	assert.ok(!REQUIRED_TABLES.includes('versions'), 'versions は migrate.mjs が作る');
	assert.ok(actual.has('versions'), '版を当てた DB に versions が無い');
});
