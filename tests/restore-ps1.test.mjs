import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const MAIN = join(ROOT, 'src', 'server', 'main.mjs');
const RESTORE = join(ROOT, 'tools', '80_ops', 'restore.ps1');
const TEST_ROOT = join(ROOT, 'tmp', '_data', 'unit-restore-ps1');

/*
 * restore.ps1 が Windows PowerShell 5.1 で通しで動くかを確かめる。
 *
 * レビュー #20 で見つかった穴（say・restart の呼び出しが 2>&1 と
 * $ErrorActionPreference = 'Stop' の組み合わせで NativeCommandError になる）は
 * pwsh 7 では再現しない。5.1 特有の挙動なので、必ず powershell.exe で確かめる。
 *
 * -DataRoot で _data・_backup・tmp\restore-work・logs の置き場を差し替える。
 * 本番の _data・_backup には一切触れない。
 */

/** Windows PowerShell 5.1 が無ければ以降は全部スキップする */
let has51 = false;
try {
	execFileSync('powershell.exe', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { stdio: 'pipe' });
	has51 = true;
} catch {
	has51 = false;
}

function freePort() {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.on('error', reject);
		probe.listen(0, '127.0.0.1', () => {
			const { port } = probe.address();
			probe.close(() => resolve(port));
		});
	});
}

async function until(check, { timeoutMs = 20000, everyMs = 200, what = '条件' } = {}) {
	const limit = Date.now() + timeoutMs;
	while (Date.now() < limit) {
		try {
			const value = await check();
			if (value) return value;
		} catch {
			/* まだ準備できていない。待つ */
		}
		await new Promise((r) => setTimeout(r, everyMs));
	}
	assert.fail(`${what} が満たされませんでした（${timeoutMs}ms）`);
}

async function removeWhenFree(dir) {
	for (let i = 0; i < 20; i++) {
		try {
			rmSync(dir, { recursive: true, force: true });
			return;
		} catch {
			await new Promise((r) => setTimeout(r, 250));
		}
	}
}

/** 版を当てた DB を作り、目印になる 1 件を積む */
async function makeMarkedDb(dbPath, bodyMark) {
	rmSync(dbPath, { force: true });
	const { migrate } = await import('../src/server/migrate.mjs');
	migrate({ dbPath });

	const { nowJst } = await import('../src/server/time.mjs');
	const db = new DatabaseSync(dbPath);
	try {
		db.prepare(
			`INSERT INTO messages (room_id, sent_at, from_connector_id, msg_kind, msg_body)
			 VALUES ('public', ?, 'test-fixture', 'say', ?)`
		).run(nowJst(), bodyMark);
	} finally {
		db.close();
	}
}

/**
 * $DataRoot 配下（_data・_backup\hourly・logs）を作り、
 * 「いまの DB」と「戻す先の zip」をそれぞれ目印つきで用意する。
 */
async function prepareFixture() {
	await removeWhenFree(TEST_ROOT);
	mkdirSync(join(TEST_ROOT, '_data'), { recursive: true });
	mkdirSync(join(TEST_ROOT, '_backup', 'hourly'), { recursive: true });
	mkdirSync(join(TEST_ROOT, 'logs'), { recursive: true });

	// いまの DB（サーバーが握る側）
	await makeMarkedDb(join(TEST_ROOT, '_data', 'chat.db'), 'リストア前のデータ');

	// 戻す先の中身（zip に固めて _backup\hourly に置く）
	const work = join(TEST_ROOT, 'zip-work');
	mkdirSync(work, { recursive: true });
	await makeMarkedDb(join(work, 'chat.db'), 'リストア後のデータ');

	const stamp = '20260101-000000';
	const zipPath = join(TEST_ROOT, '_backup', 'hourly', `chat-${stamp}.db.zip`);
	execFileSync('powershell.exe', [
		'-NoProfile', '-Command',
		`Compress-Archive -LiteralPath '${join(work, 'chat.db')}' -DestinationPath '${zipPath}'`,
	]);
	rmSync(work, { recursive: true, force: true });

	return zipPath;
}

let port;
let server;

before(async () => {
	port = await freePort();
});

after(async () => {
	if (server && server.exitCode === null) {
		server.kill();
	}
	await removeWhenFree(TEST_ROOT);
});

test('Windows PowerShell 5.1 が使える（無ければ以降は skip）', (t) => {
	if (!has51) t.skip('powershell.exe が無い環境');
	assert.ok(true);
});

test('restore.ps1 が通しで動き、目印が入れ替わる（5.1・実サーバー）', async (t) => {
	if (!has51) return t.skip('powershell.exe が無い');

	await prepareFixture();

	// -Data のあるサーバーを実際に立てる。restore.ps1 の restart が
	// このプロセスを本当に落とせることを確かめるため（AICHAT_NO_EXIT は使わない）。
	//
	// アクセストークンは spawn した「この」プロセスが自分で振った値（起動ログの
	// 1 行）を読む。config.mjs は randomUUID() で毎プロセス独立に決めるため、
	// テスト側で import した config.mjs の値とは食い違う（別プロセスの別の値）
	let token = '';
	server = spawn(process.execPath, [MAIN], {
		env: { ...process.env, AICHAT_DATA: join(TEST_ROOT, '_data'), AICHAT_PORT: String(port) },
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	server.stdout.setEncoding('utf8');
	server.stdout.on('data', (c) => {
		const m = c.match(/アクセストークン: (\S+)/);
		if (m) token = m[1];
	});
	await until(async () => (await fetch(`http://127.0.0.1:${port}/api/version`)).ok, { what: 'テスト用サーバーの起動' });
	await until(() => token !== '', { what: 'アクセストークンの取得' });

	const result = spawn('powershell.exe', [
		'-NoProfile', '-File', RESTORE, '-Force', '-DataRoot', TEST_ROOT, '-AccessToken', token,
	], {
		env: { ...process.env, AICHAT_PORT: String(port) },
	});
	let stdout = '';
	let stderr = '';
	result.stdout.setEncoding('utf8');
	result.stderr.setEncoding('utf8');
	result.stdout.on('data', (c) => { stdout += c; });
	result.stderr.on('data', (c) => { stderr += c; });
	const code = await new Promise((resolve) => result.once('exit', resolve));

	assert.equal(code, 0, `restore.ps1 が失敗した（exit ${code}）\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`);
	assert.match(stdout, /\[5\/5\]/, '最後まで進んでいない');
	assert.ok(!existsSync(join(TEST_ROOT, '_data', 'MAINTENANCE')), '印が残っている');

	// 入れ替わった DB を読み、戻したはずの目印が入っていることを確かめる
	const db = new DatabaseSync(join(TEST_ROOT, '_data', 'chat.db'), { readOnly: true });
	let bodies;
	try {
		bodies = db.prepare('SELECT msg_body FROM messages').all().map((r) => r.msg_body);
	} finally {
		db.close();
	}
	assert.ok(bodies.includes('リストア後のデータ'), '戻した中身になっていない');
	assert.ok(!bodies.includes('リストア前のデータ'), '前の中身がまだ残っている');
});
