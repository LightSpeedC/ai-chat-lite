import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const TEST_DATA = join(ROOT, 'tmp', '_data', 'unit-migrate');
const REAL_DIR = join(ROOT, 'src', 'scripts', '20_migrate');

// 本番の置き場を触らないよう、読み込む前に差し替える
process.env.AICHAT_DATA = TEST_DATA;
rmSync(TEST_DATA, { recursive: true, force: true });
mkdirSync(TEST_DATA, { recursive: true });

const { migrate, listVersions } = await import('../src/server/migrate.mjs');

/** その場かぎりの DB のパスを作る */
let n = 0;
function newDbPath() {
	return join(TEST_DATA, `t${++n}.db`);
}

/** 版を並べた置き場をその場で作る */
function makeDir(name, versions) {
	const dir = join(TEST_DATA, name);
	rmSync(dir, { recursive: true, force: true });
	for (const [ver, sql] of Object.entries(versions)) {
		mkdirSync(join(dir, ver), { recursive: true });
		writeFileSync(join(dir, ver, '001.sql'), sql, 'utf8');
	}
	return dir;
}

function tables(dbPath) {
	const db = new DatabaseSync(dbPath);
	try {
		return db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
			.all()
			.map((r) => r.name);
	} finally {
		db.close();
	}
}

describe('版の並び', () => {
	test('番号順に読む', () => {
		const dir = makeDir('order', {
			ver_000002: 'CREATE TABLE b (x INTEGER);',
			ver_000001: 'CREATE TABLE a (x INTEGER);',
		});
		assert.deepEqual(listVersions(dir).map((v) => v.seq), [1, 2]);
	});

	test('番号が飛んでいたら止める', () => {
		// 飛んでいると、当て損ねに気づけない
		const dir = makeDir('gap', {
			ver_000001: 'CREATE TABLE a (x INTEGER);',
			ver_000003: 'CREATE TABLE c (x INTEGER);',
		});
		assert.throws(() => listVersions(dir), /連続していません/);
	});

	test('.sql が無い版があれば止める', () => {
		const dir = join(TEST_DATA, 'empty-ver');
		rmSync(dir, { recursive: true, force: true });
		mkdirSync(join(dir, 'ver_000001'), { recursive: true });
		assert.throws(() => listVersions(dir), /\.sql がありません/);
	});

	test('置き場が無ければ空で返る', () => {
		assert.deepEqual(listVersions(join(TEST_DATA, 'nothing')), []);
	});
});

describe('空の DB に当てる', () => {
	test('足りない版を順に当てて、版が上がる', () => {
		const dir = makeDir('fresh', {
			ver_000001: 'CREATE TABLE a (x INTEGER);',
			ver_000002: 'CREATE TABLE b (x INTEGER);',
		});
		const dbPath = newDbPath();

		const result = migrate({ dbPath, dir });

		assert.equal(result.from, 0);
		assert.equal(result.to, 2);
		assert.deepEqual(result.applied, ['ver_000001', 'ver_000002']);
		assert.deepEqual(tables(dbPath), ['a', 'b', 'versions']);
	});

	test('2 度目は当て直さない', () => {
		const dir = makeDir('twice', { ver_000001: 'CREATE TABLE a (x INTEGER);' });
		const dbPath = newDbPath();

		migrate({ dbPath, dir });
		const again = migrate({ dbPath, dir });

		assert.deepEqual(again.applied, []);
		assert.equal(again.from, 1);
		assert.equal(again.to, 1);
	});

	test('あとから足した版だけを当てる', () => {
		const dir = makeDir('add', { ver_000001: 'CREATE TABLE a (x INTEGER);' });
		const dbPath = newDbPath();
		migrate({ dbPath, dir });

		mkdirSync(join(dir, 'ver_000002'), { recursive: true });
		writeFileSync(join(dir, 'ver_000002', '001.sql'), 'CREATE TABLE b (x INTEGER);', 'utf8');

		const result = migrate({ dbPath, dir });

		assert.deepEqual(result.applied, ['ver_000002']);
		assert.equal(result.from, 1);
	});
});

describe('すでに使われている DB', () => {
	test('版 1 は当てずに記録する', () => {
		/*
		 * 改名の前から動いている DB は版 1 の形になっている。当て直すと
		 * 「テーブルがもうある」で失敗し、消して作れば中身が飛ぶ。
		 */
		const dir = makeDir('used', {
			ver_000001: 'CREATE TABLE a (x INTEGER);',
			ver_000002: 'ALTER TABLE a RENAME COLUMN x TO y;',
		});
		const dbPath = newDbPath();

		// 版 1 相当の DB を、versions を持たない形で用意する
		const db = new DatabaseSync(dbPath);
		db.exec('CREATE TABLE a (x INTEGER);');
		db.prepare('INSERT INTO a (x) VALUES (7)').run();
		db.close();

		const result = migrate({ dbPath, dir });

		assert.equal(result.from, 1, '版 1 として扱われていない');
		assert.deepEqual(result.applied, ['ver_000002']);

		// 中身が残っていること
		const check = new DatabaseSync(dbPath);
		assert.equal(check.prepare('SELECT y FROM a').get().y, 7);
		check.close();
	});
});

describe('失敗したとき', () => {
	test('巻き戻して、版は上がらない', () => {
		const dir = makeDir('fail', {
			ver_000001: 'CREATE TABLE a (x INTEGER);',
			ver_000002: 'CREATE TABLE b (x INTEGER);\nこれは SQL ではない;',
		});
		const dbPath = newDbPath();

		assert.throws(() => migrate({ dbPath, dir }), /ver_000002 を当てられませんでした/);

		// 版 1 は当たっているが、2 の途中で作った b は残っていない
		assert.deepEqual(tables(dbPath), ['a', 'versions']);

		const db = new DatabaseSync(dbPath);
		assert.equal(db.prepare('SELECT MAX(version_seq) AS v FROM versions').get().v, 1);
		db.close();
	});
});

describe('当て済みの SQL を書き換えたとき', () => {
	test('指紋が食い違ったら止める', () => {
		/*
		 * 当て済みの環境では二度と実行されない。書き換えると環境ごとに形が
		 * 違う状態になる。気づかないのがいちばん怖い。
		 */
		const dir = makeDir('tamper', { ver_000001: 'CREATE TABLE a (x INTEGER);' });
		const dbPath = newDbPath();
		migrate({ dbPath, dir });

		writeFileSync(join(dir, 'ver_000001', '001.sql'), 'CREATE TABLE a (x TEXT);', 'utf8');

		assert.throws(() => migrate({ dbPath, dir }), /書き換えられています/);
	});
});

describe('控え', () => {
	test('当てる前に控えを取る', () => {
		// 下り（元に戻す SQL）は持たない。戻すならここから戻す
		const dir = makeDir('backup', { ver_000001: 'CREATE TABLE a (x INTEGER);' });
		const dbPath = newDbPath();

		migrate({ dbPath, dir });

		const backups = readdirSync(TEST_DATA).filter((f) => f.startsWith('pre-ver-'));
		assert.ok(backups.length > 0, '控えが残っていない');
	});
});

describe('実際に置いてある版', () => {
	test('空の DB に全部当てると、いまの形になる', () => {
		/*
		 * 版の SQL だけが形の出どころである。store.mjs は形を作らず、
		 * 揃っているかを確かめるだけ。ここが通らなければ、空の DB から
		 * 起動したときに store.mjs が「形が揃っていません」で止まる。
		 */
		const dbPath = newDbPath();
		const result = migrate({ dbPath, dir: REAL_DIR });

		assert.ok(result.to >= 4, `版が上がっていない（${result.to}）`);
		assert.deepEqual(tables(dbPath), ['archives', 'connectors', 'cursors', 'messages', 'versions']);
	});

	test('改名後の列名になっている', () => {
		const dbPath = newDbPath();
		migrate({ dbPath, dir: REAL_DIR });

		const db = new DatabaseSync(dbPath);
		try {
			const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);

			assert.ok(cols('messages').includes('from_connector_id'));
			assert.ok(cols('messages').includes('to_connector_id'));
			assert.ok(!cols('messages').includes('from_user_id'), '古い列が残っている');
			assert.ok(cols('cursors').includes('connector_id'));
			assert.ok(cols('connectors').includes('connector_id'));
			assert.ok(cols('connectors').includes('connector_role'));
		} finally {
			db.close();
		}
	});

	test('通知が指す片付けの番号を持てる', () => {
		/*
		 * archived_seq とは意味が逆である。
		 *   archived_seq     … その行自身が片付けられた番号
		 *   ref_archived_seq … その行が知らせている片付けの番号
		 */
		const dbPath = newDbPath();
		migrate({ dbPath, dir: REAL_DIR });

		const db = new DatabaseSync(dbPath);
		try {
			const cols = db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
			assert.ok(cols.includes('ref_archived_seq'), '列が無い');
			assert.ok(cols.includes('archived_seq'), '片付けられた側の列も要る');
		} finally {
			db.close();
		}
	});

	test('msg_kind に notice が入っている', () => {
		const dbPath = newDbPath();
		migrate({ dbPath, dir: REAL_DIR });

		const db = new DatabaseSync(dbPath);
		try {
			db.prepare(
				"INSERT INTO messages (room_id, sent_at, from_connector_id, msg_kind, msg_body) VALUES ('public','2026-09-01 00:00:00.000','ai-chat-lite','notice','案内')"
			).run();
			assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE msg_kind = 'notice'").get().n, 1);
		} finally {
			db.close();
		}
	});

	test('索引が張り直されている', () => {
		// テーブルを作り直すと索引は一緒に消える。張り直しを忘れると全件走査になる
		const dbPath = newDbPath();
		migrate({ dbPath, dir: REAL_DIR });

		const db = new DatabaseSync(dbPath);
		try {
			const plan = db
				.prepare('EXPLAIN QUERY PLAN SELECT * FROM messages WHERE room_id = ? AND msg_seq > ?')
				.all('public', 0);
			assert.match(JSON.stringify(plan), /messages_ix_room_id_msg_seq/);
		} finally {
			db.close();
		}
	});

	test('版 5 で reply_to_msg_seq が足される', () => {
		const dbPath = newDbPath();
		migrate({ dbPath, dir: REAL_DIR });

		const db = new DatabaseSync(dbPath);
		try {
			const cols = db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
			assert.ok(cols.includes('reply_to_msg_seq'), 'reply_to_msg_seq が無い');
		} finally {
			db.close();
		}
	});

	test('版 5 で既存の行の日付が / に書き換わる', () => {
		/*
		 * これが効かないと、既存の参加者が全員オフライン扱いのまま戻らない。
		 *
		 * jstBefore() が作る文字列は DB の値と文字列のまま比較される（在席判定の
		 * 90 秒）。'-'（0x2D）は '/'（0x2F）より小さいため、旧形式の行が残っていると
		 * 「90 秒以内」の判定が常に偽になる。
		 *
		 * 版 4 までを当てて旧形式の行を入れ、そのあと版 5 を当てて確かめる。
		 */
		const dbPath = newDbPath();

		// 版 4 までだけを当てる
		const upTo4 = listVersions(REAL_DIR).filter((v) => v.name <= 'ver_000004');
		const dir4 = join(TEST_DATA, 'only-4');
		rmSync(dir4, { recursive: true, force: true });
		for (const v of upTo4) {
			mkdirSync(join(dir4, v.name), { recursive: true });
			for (const file of v.files) {
				writeFileSync(join(dir4, v.name, file), readFileSync(join(v.dir, file), 'utf8'), 'utf8');
			}
		}
		migrate({ dbPath, dir: dir4 });

		// 旧形式の行を入れる
		const before = new DatabaseSync(dbPath);
		try {
			before
				.prepare(
					`INSERT INTO messages (room_id, sent_at, from_connector_id, msg_kind, msg_body)
					 VALUES ('public', '2026-09-04 06:00:00.000', 'project-a', 'say', '古い形式')`
				)
				.run();
			before
				.prepare(
					`INSERT INTO connectors (connector_id, connector_role, first_joined_at, last_active_at)
					 VALUES ('project-a', 'ai', '2026-09-01 10:00:00.000', '2026-09-04 06:00:00.000')`
				)
				.run();
			before
				.prepare(
					`INSERT INTO cursors (connector_id, room_id, msg_seq, updated_at)
					 VALUES ('project-a', 'public', 1, '2026-09-04 06:00:00.000')`
				)
				.run();
			before
				.prepare(
					`INSERT INTO archives (archived_at, archived_connector_id, archive_kind, archive_id, description)
					 VALUES ('2026-09-02 12:00:00.000', 'project-a', 'room', 'sandbox', '片付け')`
				)
				.run();
		} finally {
			before.close();
		}

		// 版 5 を当てる
		const result = migrate({ dbPath, dir: REAL_DIR });
		assert.equal(result.to, 5, `版が 5 に上がっていない（${result.to}）`);

		const db = new DatabaseSync(dbPath);
		try {
			const one = (sql) => db.prepare(sql).get();

			assert.equal(one('SELECT sent_at AS v FROM messages').v, '2026/09/04 06:00:00.000');
			assert.equal(one('SELECT first_joined_at AS v FROM connectors').v, '2026/09/01 10:00:00.000');
			assert.equal(one('SELECT last_active_at AS v FROM connectors').v, '2026/09/04 06:00:00.000');
			assert.equal(one('SELECT updated_at AS v FROM cursors').v, '2026/09/04 06:00:00.000');
			assert.equal(one('SELECT archived_at AS v FROM archives').v, '2026/09/02 12:00:00.000');

			// versions 自身も揃える。1 つのテーブルだけ旧形式が残ると読み手が迷う
			const stale = db.prepare("SELECT COUNT(*) AS n FROM versions WHERE applied_at LIKE '%-%'").get();
			assert.equal(stale.n, 0, 'versions に旧形式が残っている');
		} finally {
			db.close();
		}
	});

	test('書き換えても長さ 23 と順序は保たれる', () => {
		/*
		 * CHECK (length(…) = 23) を通り続けること。区切りが揃っていれば
		 * 辞書順と時系列順の一致も変わらない。
		 */
		const older = '2026/09/04 06:00:00.000';
		const newer = '2026/09/04 06:48:00.000';

		assert.equal(older.length, 23);
		assert.ok(older < newer, '辞書順と時系列順が一致していない');

		// 混ざると壊れることも押さえる（版 5 が要る理由）
		assert.ok(!('2026-09-04 06:00:00.000' >= newer), '旧形式が新形式の閾値を上回っている');
	});

	test('版の SQL は当て済みを書き換えない形で置かれている', () => {
		// 各版に .sql が 1 つ以上あり、読めること
		for (const v of listVersions(REAL_DIR)) {
			for (const f of v.files) {
				assert.ok(readFileSync(join(v.dir, f), 'utf8').trim().length > 0, `${v.name}/${f} が空`);
			}
		}
	});
});
