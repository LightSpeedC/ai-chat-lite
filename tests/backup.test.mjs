import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, existsSync, readdirSync, utimesSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/*
 * ROOT を config.mjs から取らない。
 *
 * config.mjs は読み込んだ時点で置き場を確定する。先に import すると、
 * そのあとで環境変数を変えても効かず、本番の _data を掴んだままになる。
 * バックアップの印（BACKUP-RUNNING）は置き場から決まるので、
 * 本番側に印を置いてしまう恐れがある。
 */
const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');

const WORK = join(ROOT, 'tmp', '_data', 'unit-backup');
const SRC = join(WORK, 'source.db');

// 本番を触らないよう、置き場を差し替えてから読み込む
process.env.AICHAT_DATA = WORK;
const {
	backupBaseName,
	vacuumInto,
	listBackups,
	pruneBackups,
	listAllBackups,
	isKnownKind,
	keepOf,
	KINDS,
	DEFAULT_KIND,
	isLockActive,
	acquireWithWait,
	acquireLock,
	releaseLock,
	readLock,
	STALE_LOCK_MS,
} = await import('../src/server/backup.mjs');

/** 中身の入った DB を用意する。WAL に書き込みを残した状態にする */
function createSourceDb() {
	const db = new DatabaseSync(SRC);
	db.exec('PRAGMA journal_mode = WAL');
	db.exec(`CREATE TABLE messages (
		msg_seq      INTEGER PRIMARY KEY AUTOINCREMENT,
		room_id      TEXT NOT NULL DEFAULT 'public',
		from_connector_id TEXT NOT NULL,
		msg_body     TEXT NOT NULL)`);
	const insert = db.prepare('INSERT INTO messages (from_connector_id, msg_body) VALUES (?, ?)');
	for (let i = 1; i <= 30; i++) insert.run('test-connector1', `本文 ${i}`);
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
		assert.equal(keepOf(DEFAULT_KIND), 8);
	});
});

describe('4 つの世代', () => {
	test('区分ごとに残す数が決まっている', () => {
		// 直近は細かく、古いものは粗く。合計 25 世代
		assert.equal(keepOf('hourly'), 8);
		assert.equal(keepOf('daily'), 7);
		assert.equal(keepOf('weekly'), 4);
		assert.equal(keepOf('monthly'), 6);
	});

	test('知らない区分は受け付けない', () => {
		// 区分の名前はフォルダ名になる。打ち間違いで別の場所に作らせない
		assert.equal(isKnownKind('hourly'), true);
		assert.equal(isKnownKind('yearly'), false);
		assert.equal(isKnownKind('..'), false);
		assert.equal(isKnownKind(''), false);
	});

	test('知らない区分でも既定の世代数が返る', () => {
		// 呼び出し側が弾く前提だが、ここで落ちて控えが取れなくなるのは困る
		assert.equal(keepOf('しらない'), keepOf(DEFAULT_KIND));
	});

	test('区分をまたいで新しい順に並ぶ', () => {
		// 戻すとき、どの区分にあるかを気にせず最新を選べるようにする
		const dir = join(WORK, 'all');
		for (const [kind, names] of Object.entries({
			hourly: ['chat-20260830-140000.db.zip', 'chat-20260830-130000.db.zip'],
			daily: ['chat-20260830-000100.db.zip'],
			weekly: ['chat-20260825-000200.db.zip'],
			monthly: ['chat-20260801-000300.db.zip'],
		})) {
			mkdirSync(join(dir, kind), { recursive: true });
			for (const n of names) writeFileSync(join(dir, kind, n), 'x');
		}

		const all = listAllBackups(dir);

		assert.equal(all.length, 5);
		assert.equal(all[0].name, 'chat-20260830-140000.db.zip');
		assert.equal(all[0].kind, 'hourly');
		assert.equal(all.at(-1).name, 'chat-20260801-000300.db.zip');
		assert.equal(all.at(-1).kind, 'monthly');
	});

	test('区分のフォルダが無くても落ちない', () => {
		// 使い始めたばかりのときは daily も weekly も空
		const dir = join(WORK, 'all-empty');
		mkdirSync(join(dir, 'hourly'), { recursive: true });
		writeFileSync(join(dir, 'hourly', 'chat-20260830-140000.db.zip'), 'x');

		const all = listAllBackups(dir);
		assert.equal(all.length, 1);
		assert.equal(all[0].kind, 'hourly');
	});

	test('区分は 4 つだけ', () => {
		assert.deepEqual(Object.keys(KINDS), ['hourly', 'daily', 'weekly', 'monthly']);
	});
});

describe('取ってはいけないときに取らない', () => {
	const LOCK_DIR = join(WORK, 'locks');

	before(() => {
		mkdirSync(LOCK_DIR, { recursive: true });
	});

	/** 指定した時間だけ古い印を作る */
	function makeLock(name, ageMs = 0) {
		const path = join(LOCK_DIR, name);
		writeFileSync(path, 'テスト用の印');
		if (ageMs > 0) {
			const at = new Date(Date.now() - ageMs);
			utimesSync(path, at, at);
		}
		return path;
	}

	test('印が無ければ効いていない', () => {
		assert.equal(isLockActive(join(LOCK_DIR, 'ない印')), false);
	});

	test('印があれば効いている', () => {
		assert.equal(isLockActive(makeLock('ある印')), true);
	});

	test('古すぎる印は残骸とみなす', () => {
		// 強制終了で残った印。これを見ないと、以降すべてが待って諦め続ける
		const stale = makeLock('古い印', STALE_LOCK_MS + 60 * 1000);
		assert.equal(isLockActive(stale, STALE_LOCK_MS), false);
	});

	test('新しい印は残骸とみなさない', () => {
		const fresh = makeLock('新しい印', 60 * 1000);
		assert.equal(isLockActive(fresh, STALE_LOCK_MS), true);
	});

	test('古さを見ない設定なら、古い印でも効いている', () => {
		// メンテナンスの印は人が置くもの。何時間置かれていても奪ってはいけない
		const stale = makeLock('人が置いた印', STALE_LOCK_MS * 10);
		assert.equal(isLockActive(stale, 0), true);
	});

	test('同時に取り合っても 1 つしか成功しない', () => {
		/*
		 * wx フラグ（O_CREAT | O_EXCL）を使う理由がこれ。
		 * 名前を変える方式は Windows では使えない。Node の renameSync は
		 * 既にある印を黙って上書きし、2 つとも「取れた」と思い込む。
		 * PowerShell の Rename-Item と cmd の ren は失敗するが、
		 * cmd の move は上書きする。シェルによって結果が変わる。
		 */
		const path = join(LOCK_DIR, 'RACE');
		rmSync(path, { force: true });

		let won = 0;
		for (let i = 0; i < 10; i++) {
			if (acquireLock(`kind${i}`, path)) won++;
		}

		assert.equal(won, 1, '複数が同時に取れてしまっている');
		assert.match(readLock(path), /kind0/, '先に取った方が残っていない');
		releaseLock(path);
	});

	test('印が無ければ待たずに取れる', async () => {
		const result = await acquireWithWait({
			file: join(LOCK_DIR, 'すぐ取れる印'),
			maintenanceFile: join(LOCK_DIR, 'ない印'),
			pollMs: 10,
			maxTries: 3,
		});
		assert.equal(result.acquired, true);
		assert.ok(result.waitedMs < 100, '待つ必要がないのに待っている');
		releaseLock(join(LOCK_DIR, 'すぐ取れる印'));
	});

	test('印が消えれば取れる', async () => {
		const path = makeLock('あとで消す印');
		setTimeout(() => rmSync(path, { force: true }), 30);

		const result = await acquireWithWait({
			file: path,
			maintenanceFile: join(LOCK_DIR, 'ない印'),
			pollMs: 10,
			maxTries: 10,
		});
		assert.equal(result.acquired, true);
		releaseLock(path);
	});

	test('印が消えなければ回数を使い切って諦める', async () => {
		const path = makeLock('消さない印');
		const tried = [];

		const result = await acquireWithWait({
			file: path,
			maintenanceFile: join(LOCK_DIR, 'ない印'),
			pollMs: 5,
			maxTries: 3,
			onWait: (info) => tried.push(info.tries),
		});

		assert.equal(result.acquired, false);
		assert.match(result.reason, /バックアップの印が消えませんでした/);
		// 3 回待って 4 回目の確認で諦める。待つ回数は maxTries と同じ
		assert.deepEqual(tried, [1, 2, 3]);
	});

	test('メンテナンス中は印を置きに行かない', async () => {
		// 置いてしまうと、人が DB を触り終えたあとも印が残る
		const maintenance = makeLock('MAINTENANCE-中');
		const running = join(LOCK_DIR, 'RUNNING-触らない');
		rmSync(running, { force: true });

		const result = await acquireWithWait({
			file: running,
			maintenanceFile: maintenance,
			pollMs: 5,
			maxTries: 1,
		});

		assert.equal(result.acquired, false);
		assert.match(result.reason, /メンテナンスの印が消えませんでした/);
		assert.equal(existsSync(running), false, 'メンテナンス中なのに印を置いている');
	});

	test('握ったまま終わった印は奪って取れる', async () => {
		// これが無いと、強制終了で残った印のせいで以降すべてが取れなくなる
		const stale = makeLock('残骸', STALE_LOCK_MS + 60 * 1000);

		const result = await acquireWithWait({
			file: stale,
			maintenanceFile: join(LOCK_DIR, 'ない印'),
			pollMs: 5,
			maxTries: 1,
			kind: 'hourly',
		});

		assert.equal(result.acquired, true);
		assert.match(readLock(stale), /hourly/, '奪ったのに中身が古いまま');
		releaseLock(stale);
	});

	test('印を置くと誰がいつ始めたかが読める', () => {
		const path = join(LOCK_DIR, 'RUNNING');
		rmSync(path, { force: true });
		assert.equal(acquireLock('hourly', path), true);

		const body = readLock(path);
		assert.match(body, /hourly/);
		assert.match(body, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
		assert.match(body, new RegExp(`pid ${process.pid}`));

		releaseLock(path);
		assert.equal(existsSync(path), false);
	});

	test('印が無い状態で消しても失敗しない', () => {
		// 取得に失敗した経路でも必ず外しにいくため、二重に消されることがある
		assert.doesNotThrow(() => releaseLock(join(LOCK_DIR, 'ない印')));
	});
});
