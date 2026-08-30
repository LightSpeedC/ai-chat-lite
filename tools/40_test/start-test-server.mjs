/*
 * テスト専用のサーバーを立てる。
 *
 * 本番（8787 / _data/chat.db）とは別のポート・別の DB で動かす。
 * 本番には他プロジェクトの AI が待ち受けているため、テストの投稿にも返事が来る。
 * ポートを分ければそもそも届かない。
 *
 * 本番サービスは止めない。ポートが違えば共存できるし、止めるには管理者権限が要る。
 *
 *   node tools/40_test/start-test-server.mjs        立てる
 *   node tools/40_test/start-test-server.mjs --stop 止める
 *
 * 立てると tmp/test-server.json に { port, db, pid, url } を書く。
 * ポートは空きを探して決まるので、テスト側はこれを読んで接続先を知る。
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, openSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const INFO = join(root, 'tmp', 'test-server.json');
const DB = join(root, 'tmp', 'test-chat.db');

/** 8765 から下へ探す。本番の 8787 とは離しておく */
const FIRST_PORT = 8765;

/*
 * 下げる回数に上限を置く。
 *
 * address in use の元をたどると、多くは前回のテストサーバーが残っている。
 * 下げ続けると多重起動が積み上がるので、10 個で諦めて知らせる。
 */
const MAX_TRIES = 10;

// --- 止める ---

if (process.argv.includes('--stop')) {
	if (!existsSync(INFO)) {
		console.log('立っていません。');
		process.exit(0);
	}
	const info = JSON.parse(readFileSync(INFO, 'utf8'));
	try {
		process.kill(info.pid);
		console.log(`止めました（pid ${info.pid} / ポート ${info.port}）。`);
	} catch (err) {
		console.log(`既に居ません（pid ${info.pid}）: ${err.code}`);
	}
	rmSync(INFO, { force: true });

	/*
	 * DB も捨てる。テスト用なので取っておく意味がない。
	 *
	 * 後始末を抜けた分（猶予のあとに積まれた離脱など）がここで確実に消える。
	 * 本体だけ消すと -wal に残った中身が次に蘇るので、3 つまとめて捨てる。
	 */
	for (const suffix of ['', '-wal', '-shm']) rmSync(DB + suffix, { force: true });
	console.log('  DB も捨てました。');
	process.exit(0);
}

// --- 空いているポートを探す ---

/** そのポートで listen できるかを確かめる。できたらすぐ閉じる */
function canListen(port) {
	return new Promise((done) => {
		const probe = createServer();
		probe.once('error', () => done(false));
		probe.once('listening', () => probe.close(() => done(true)));
		probe.listen(port, '127.0.0.1');
	});
}

async function findPort() {
	for (let i = 0; i < MAX_TRIES; i++) {
		const port = FIRST_PORT - i;
		if (await canListen(port)) return port;
		console.log(`  ${port} は使われています`);
	}
	throw new Error(
		`${FIRST_PORT} から ${MAX_TRIES} 個下げても空きがありません。` +
			'前のテストサーバーが残っていないか確かめてください。'
	);
}

// --- 立てる ---

/** サーバーが応えるまで待つ。プロセスが起きても listen までに間がある */
async function waitReady(url, ms = 15000) {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		try {
			const res = await fetch(`${url}/api/version`);
			if (res.ok) return true;
		} catch {
			/* まだ立っていない */
		}
		await new Promise((r) => setTimeout(r, 200));
	}
	return false;
}

mkdirSync(join(root, 'tmp'), { recursive: true });

// 前の DB は捨てる。3 つまとめて消さないと、前の中身が -wal から蘇る
for (const suffix of ['', '-wal', '-shm']) rmSync(DB + suffix, { force: true });

const port = await findPort();
const url = `http://localhost:${port}`;

/*
 * 出力はログに落とす。捨てると立ち上がらなかったときに理由が分からない。
 * 実際に一度これで詰まった。
 */
const LOG = join(root, 'tmp', 'test-server.log');
rmSync(LOG, { force: true });
const log = openSync(LOG, 'a');

// 入口は main.mjs。server.mjs は startServers を export するだけで、直に叩いても何も起きない
const child = spawn(process.execPath, [join(root, 'src', 'server', 'main.mjs')], {
	cwd: root,
	env: { ...process.env, AICHAT_PORT: String(port), AICHAT_DB: DB },
	detached: true,
	stdio: ['ignore', log, log],
});
child.unref();

if (!(await waitReady(url))) {
	try {
		process.kill(child.pid);
	} catch {
		/* 既に落ちている */
	}
	const tail = existsSync(LOG) ? readFileSync(LOG, 'utf8').trim() : '(ログがありません)';
	throw new Error(`立ち上がりません（ポート ${port}）。\n--- サーバーの出力 ---\n${tail}`);
}

writeFileSync(INFO, JSON.stringify({ port, db: DB, pid: child.pid, url }, null, '\t') + '\n');

console.log(`テスト用サーバーを立てました。`);
console.log(`  ポート  ${port}`);
console.log(`  DB      ${DB.replace(root, '.')}`);
console.log(`  pid     ${child.pid}`);
