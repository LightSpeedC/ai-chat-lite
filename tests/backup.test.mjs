import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { ROOT } from '../src/server/config.mjs';

const WORK = join(ROOT, 'tmp', 'test-backup');
const SRC = join(WORK, 'source.db');

// 本番の DB を触らないよう、環境変数で差し替えてから読み込む
process.env.AICHAT_DB = SRC;
const { backupBaseName, vacuumInto, listBackups, pruneBackups, KEEP_GENERATIONS } = await import(
	'../src/server/backup.mjs'
);

/** 中身の入った DB を用意する。WAL に書き込みを残した状態にする */
function createSourceDb() {
	const db = new DatabaseSync(SRC);
	db.exec('PRAGMA journal_mode = WAL');
	db.exec(`CREATE TABLE messages (
		msg_seq      INTEGER PRIMARY KEY AUTOINCREMENT,
		room_id      TEXT NOT NULL DEFAULT 'public',
		from_user_id TEXT NOT NULL,
		msg_body     TEXT NOT NULL)`);
	const insert = db.prepare('INSERT INTO messages (from_user_id, msg_body) VALUES (?, ?)');
	for (let i = 1; i <= 30; i++) insert.run('user1', `本文 ${i}`);
	// close せずに返す。WAL に載ったまま複製できるかを見たいため
	return db;
}

describe('バックアップ', () => {
	let source = null;

	before(() => {
		rmSync(WORK, { recursive: true, force: true });
		mkdirSync(WORK, { recursive: true });
		source = createSourceDb();
	});

	after(() => {
		source?.close();
	});

	test('名前は chat-yyyymmdd-hhmmss の形で、日時の桁が揃っている', () => {
		const name = backupBaseName('2026-08-30 09:05:03.123');
		assert.equal(name, 'chat-20260830-090503');
	});

	test('名前は辞書順に並べると時系列順になる', () => {
		// 索引を持たずに「新しい順」を出せているのは、この一致があるため
		const names = [
			backupBaseName('2026-09-01 00:00:00.000'),
			backupBaseName('2026-08-30 23:59:59.999'),
			backupBaseName('2026-08-30 09:05:03.123'),
		];
		assert.deepEqual([...names].sort(), [...names].reverse());
	});

	test('WAL に残っている書き込みも含めて複製される', () => {
		// 本体のファイルコピーでは取りこぼす分。VACUUM INTO を選んだ理由そのもの
		const dest = join(WORK, 'snapshot.db');
		const result = vacuumInto(dest, SRC);

		assert.equal(result.messages, 30);
		assert.ok(result.bytes > 0);

		const copy = new DatabaseSync(dest, { readOnly: true });
		const found = copy.prepare('SELECT count(*) AS c FROM messages').get().c;
		copy.close();
		assert.equal(found, 30, 'WAL の内容が複製に入っていない');
	});

	test('複製は -wal を伴わず単体で開ける', () => {
		// 復旧のとき zip の中の 1 ファイルだけを置けば済むことを保証する
		const dest = join(WORK, 'standalone.db');
		vacuumInto(dest, SRC);

		assert.ok(!existsSync(dest + '-wal'), '-wal が作られている');
		assert.ok(!existsSync(dest + '-shm'), '-shm が作られている');
	});

	test('元の DB が無ければエラーになる', () => {
		assert.throws(
			() => vacuumInto(join(WORK, 'x.db'), join(WORK, 'ない.db')),
			/元の DB がありません/
		);
	});

	test('出力先が既にあれば上書きせずエラーになる', () => {
		// 黙って上書きすると、直前のバックアップを失う
		const dest = join(WORK, 'dup.db');
		vacuumInto(dest, SRC);
		assert.throws(() => vacuumInto(dest, SRC), /出力先が既にあります/);
	});

	test('バックアップ以外のファイルは一覧に混ざらない', () => {
		const dir = join(WORK, 'list');
		mkdirSync(dir, { recursive: true });
		for (const name of [
			'chat-20260830-090000.db.zip',
			'chat-20260829-090000.db.zip',
			'chat.db', // 名前の形が違う
			'メモ.txt',
			'chat-20260830-090000.db.zip.tmp', // 途中で失敗した残骸
		]) {
			writeFileSync(join(dir, name), 'x');
		}
		assert.deepEqual(listBackups(dir), [
			'chat-20260830-090000.db.zip',
			'chat-20260829-090000.db.zip',
		]);
	});

	test('一覧は新しい順に並ぶ', () => {
		const dir = join(WORK, 'order');
		mkdirSync(dir, { recursive: true });
		// わざと古い順に作る。更新日時ではなく名前で並べていることを確かめる
		for (const name of [
			'chat-20260828-235959.db.zip',
			'chat-20260830-000000.db.zip',
			'chat-20260829-120000.db.zip',
		]) {
			writeFileSync(join(dir, name), 'x');
		}
		assert.deepEqual(listBackups(dir), [
			'chat-20260830-000000.db.zip',
			'chat-20260829-120000.db.zip',
			'chat-20260828-235959.db.zip',
		]);
	});

	test('世代を超えた分だけが古いものから消える', () => {
		const dir = join(WORK, 'prune');
		mkdirSync(dir, { recursive: true });
		for (let d = 1; d <= 12; d++) {
			writeFileSync(join(dir, `chat-202608${String(d).padStart(2, '0')}-120000.db.zip`), 'x');
		}

		const removed = pruneBackups(dir, 8);

		assert.equal(removed.length, 4);
		assert.deepEqual(listBackups(dir).length, 8);
		// 残ったのは新しい 8 件
		assert.equal(listBackups(dir).at(0), 'chat-20260812-120000.db.zip');
		assert.equal(listBackups(dir).at(-1), 'chat-20260805-120000.db.zip');
	});

	test('世代に満たなければ何も消えない', () => {
		const dir = join(WORK, 'prune-few');
		mkdirSync(dir, { recursive: true });
		for (let d = 1; d <= 3; d++) {
			writeFileSync(join(dir, `chat-202608${String(d).padStart(2, '0')}-120000.db.zip`), 'x');
		}

		assert.deepEqual(pruneBackups(dir, 8), []);
		assert.equal(listBackups(dir).length, 3);
	});

	test('バックアップ以外のファイルは整理で消されない', () => {
		// _backup に人が置いたメモを巻き添えにしない
		const dir = join(WORK, 'prune-safe');
		mkdirSync(dir, { recursive: true });
		for (let d = 1; d <= 10; d++) {
			writeFileSync(join(dir, `chat-202608${String(d).padStart(2, '0')}-120000.db.zip`), 'x');
		}
		writeFileSync(join(dir, '戻し方.md'), 'x');

		pruneBackups(dir, 8);

		assert.ok(readdirSync(dir).includes('戻し方.md'));
	});

	test('フォルダが無ければ一覧は空になる', () => {
		assert.deepEqual(listBackups(join(WORK, 'ないフォルダ')), []);
		assert.deepEqual(pruneBackups(join(WORK, 'ないフォルダ')), []);
	});

	test('残す世代の既定は 8', () => {
		assert.equal(KEEP_GENERATIONS, 8);
	});
});
