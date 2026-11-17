import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const TEST_DATA = join(ROOT, 'tmp', '_data', 'unit-migrate-msg-id');
const REAL_DIR = join(ROOT, 'src', 'scripts', '20_migrate');

process.env.AICHAT_DATA = TEST_DATA;
rmSync(TEST_DATA, { recursive: true, force: true });
mkdirSync(TEST_DATA, { recursive: true });

const { migrate, listVersions } = await import('../src/server/migrate.mjs');
const { makeMsgId, dayOfSentAt } = await import('../src/server/msg-id.mjs');

let n = 0;
const newDbPath = () => join(TEST_DATA, `t${++n}.db`);

/** 版 7 までだけを並べた置き場 */
function dirUpTo7() {
	const dir = join(TEST_DATA, 'only-7');
	rmSync(dir, { recursive: true, force: true });
	for (const v of listVersions(REAL_DIR).filter((x) => x.name <= 'ver_000007')) {
		mkdirSync(join(dir, v.name), { recursive: true });
		for (const f of v.files) writeFileSync(join(dir, v.name, f), readFileSync(join(v.dir, f), 'utf8'), 'utf8');
	}
	return dir;
}

/**
 * 版 7 の DB に、日をまたぐ発言を入れる。msg_seq は途中に欠け (10 番) を作り、
 * 日の順と msg_seq の順を同じにする。2 日目に片付けた行と返信を含める。
 */
function seedV7(dbPath, { perDay = [3, 2, 5] } = {}) {
	migrate({ dbPath, dir: dirUpTo7() });
	const db = new DatabaseSync(dbPath);
	const ins = db.prepare(
		`INSERT INTO messages (room_id, sent_at, from_connector_id, msg_kind, msg_body, reply_to_msg_seq)
		 VALUES ('public', ?, 'test-a', 'say', ?, ?)`
	);
	const days = ['2026/09/01', '2026/09/02', '2026/09/30'];
	let total = 0;
	perDay.forEach((count, d) => {
		for (let i = 0; i < count; i++) {
			total++;
			ins.run(`${days[d]} 10:00:${String(i).padStart(2, '0')}.000`, `本文${total}`, total > 1 ? total - 1 : null);
		}
	});
	db.prepare("INSERT INTO connectors (connector_id, connector_role, first_joined_at, last_active_at) VALUES ('test-a','ai','2026/09/01 09:00:00.000','2026/09/01 09:00:00.000')").run();
	db.prepare("INSERT INTO cursors (connector_id, room_id, msg_seq, acked_seq, updated_at) VALUES ('test-a','public',4,3,'2026/09/02 10:00:00.000')").run();
	db.prepare("INSERT INTO archives (archived_at, archived_connector_id, archive_kind, archive_id, description) VALUES ('2026/09/03 00:00:00.000','test-a','message','5','x')").run();
	db.prepare('UPDATE messages SET archived_seq = 1 WHERE msg_seq = 5').run();
	db.prepare("DELETE FROM sqlite_sequence WHERE name = 'messages'").run();
	db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('messages', ?)").run(total + 7); // 欠番のある採番
	db.close();
	return total;
}

const all = (dbPath, sql) => {
	const db = new DatabaseSync(dbPath);
	try {
		return db.prepare(sql).all().map((r) => ({ ...r }));
	} finally {
		db.close();
	}
};

describe('版 8・9 (発言番号 msg_id)', () => {
	test('全件に msg_id が付き、日ごとの msg_seq 順と同じ順になる', () => {
		const dbPath = newDbPath();
		const total = seedV7(dbPath);
		const before = all(dbPath, 'SELECT msg_seq, sent_at, reply_to_msg_seq, archived_seq FROM messages ORDER BY msg_seq');

		const result = migrate({ dbPath, dir: REAL_DIR });
		assert.deepEqual(result.applied, ['ver_000008', 'ver_000009']);

		const rows = all(dbPath, 'SELECT msg_seq, msg_id, sent_at, reply_to_msg_seq, archived_seq FROM messages ORDER BY msg_seq');
		assert.equal(rows.length, total);
		const count = {};
		for (const r of rows) {
			const day = dayOfSentAt(r.sent_at);
			count[day] = (count[day] ?? 0) + 1;
			assert.equal(r.msg_id, makeMsgId(day, count[day]), `msg_seq ${r.msg_seq}`);
		}
		// msg_seq・返信先・片付けの印は版の前後で同じ
		assert.deepEqual(
			rows.map((r) => [r.msg_seq, r.sent_at, r.reply_to_msg_seq, r.archived_seq]),
			before.map((r) => [r.msg_seq, r.sent_at, r.reply_to_msg_seq, r.archived_seq].map((v) => v))
		);
		assert.equal(rows[0].msg_id, 'm260901-01');
		assert.equal(rows[total - 1].msg_id, 'm260930-05');
	});

	test('cursors・archives は触らず、採番 (sqlite_sequence) も続きから', () => {
		const dbPath = newDbPath();
		const total = seedV7(dbPath);
		migrate({ dbPath, dir: REAL_DIR });

		assert.deepEqual(all(dbPath, 'SELECT msg_seq, acked_seq FROM cursors'), [{ msg_seq: 4, acked_seq: 3 }]);
		assert.equal(all(dbPath, 'SELECT COUNT(*) AS n FROM archives')[0].n, 1);
		assert.equal(all(dbPath, "SELECT seq FROM sqlite_sequence WHERE name = 'messages'")[0].seq, total + 7);
		assert.equal(all(dbPath, "SELECT COUNT(*) AS n FROM sqlite_sequence WHERE name = 'messages_new'")[0].n, 0);
	});

	test('台帳 message_day_counters の件数が日ごとの件数と一致する', () => {
		const dbPath = newDbPath();
		seedV7(dbPath);
		migrate({ dbPath, dir: REAL_DIR });
		assert.deepEqual(
			all(dbPath, 'SELECT message_day, last_count FROM message_day_counters ORDER BY message_day'),
			[
				{ message_day: '260901', last_count: 3 },
				{ message_day: '260902', last_count: 2 },
				{ message_day: '260930', last_count: 5 },
			]
		);
	});

	test('NOT NULL・形の CHECK・UNIQUE が効く', () => {
		const dbPath = newDbPath();
		seedV7(dbPath);
		migrate({ dbPath, dir: REAL_DIR });

		const db = new DatabaseSync(dbPath);
		try {
			const ins = (id) =>
				db
					.prepare(
						`INSERT INTO messages (room_id, sent_at, from_connector_id, msg_kind, msg_body, msg_id)
						 VALUES ('public', '2026/10/01 00:00:00.000', 'test-a', 'say', 'x', ?)`
					)
					.run(id);
			assert.throws(() => ins(null), /NOT NULL/);
			assert.throws(() => db.prepare("INSERT INTO messages (room_id, sent_at, from_connector_id, msg_kind, msg_body) VALUES ('public','2026/10/01 00:00:00.000','test-a','say','x')").run(), /NOT NULL/);
			for (const bad of ['#12', 'm261001-0', 'm26101-01', 'M261001-01', 'm261001-0l', 'm261001-', '2031']) {
				assert.throws(() => ins(bad), /CHECK/, bad);
			}
			ins('m261001-01');
			assert.throws(() => ins('m261001-01'), /UNIQUE/);
		} finally {
			db.close();
		}
	});

	test('索引が張り直されている (room_id+msg_seq・archived_seq・room_id+sent_at)', () => {
		const dbPath = newDbPath();
		seedV7(dbPath);
		migrate({ dbPath, dir: REAL_DIR });
		const names = all(dbPath, "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'messages'").map((r) => r.name);
		for (const want of ['messages_ix_room_id_msg_seq', 'messages_ix_archived_seq', 'messages_ix_room_id_sent_at']) {
			assert.ok(names.includes(want), `${want} が無い`);
		}
	});

	test('1 日が 1,189 件を超える DB は版 8 で止まり、版は上がらない', () => {
		const dbPath = newDbPath();
		migrate({ dbPath, dir: dirUpTo7() });
		const db = new DatabaseSync(dbPath);
		db.exec('BEGIN');
		const ins = db.prepare("INSERT INTO messages (room_id, sent_at, from_connector_id, msg_kind, msg_body) VALUES ('public','2026/09/01 10:00:00.000','test-a','say','x')");
		for (let i = 0; i < 1190; i++) ins.run();
		db.exec('COMMIT');
		db.close();

		assert.throws(() => migrate({ dbPath, dir: REAL_DIR }), /ver_000008 を当てられませんでした/);
		assert.equal(all(dbPath, 'SELECT MAX(version_seq) AS v FROM versions')[0].v, 7);
		assert.equal(all(dbPath, "SELECT COUNT(*) AS n FROM pragma_table_info('messages') WHERE name = 'msg_id'")[0].n, 0);
	});

	test('空の DB に全部当てても通る', () => {
		const dbPath = newDbPath();
		migrate({ dbPath, dir: REAL_DIR });
		assert.equal(all(dbPath, 'SELECT COUNT(*) AS n FROM messages')[0].n, 0);
		assert.equal(all(dbPath, 'SELECT COUNT(*) AS n FROM message_day_counters')[0].n, 0);
	});
});
